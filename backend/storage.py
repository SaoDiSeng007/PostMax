"""数据持久化：整个应用的状态落在单个 JSON 文件里。

用 JSON 而不是 SQLite 的理由：单机自用、数据量小，而 JSON 能直接打开看、
能复制、能备份、也能拿 git 管；万一写坏了，肉眼就能改回来。
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import time

# 历史只保留最近这么多条，防止文件无限膨胀
MAX_HISTORY = 200

# 存档格式版本。前端 store.js 有一份同名的，改格式时两边一起动。
#
# 它真正的用处是认出「这份存档比本程序新」：新版本写过之后又回退到旧版本跑，
# 旧版本读不懂新字段，随手一保存就把它们抹了。所以前端一旦发现存档版本更高，
# 会直接停用自动保存（只读），而不是冒险覆盖。
SCHEMA_VERSION = 1

# 自动备份：每次真正要改盘之前，先把旧档留一份；只保留最近这么多份
BACKUP_KEEP = 10

# 两份备份之间至少隔这么久。自动保存是 400ms 一次，不设门槛会刷出一屋子备份，
# 而恢复点要的是「隔一段时间的 n 份」，不是「刚才那 200 次编辑」。
# 按 5 分钟一份、留 10 份算，能回看到最近约 50 分钟的改动。
BACKUP_MIN_GAP_SECONDS = 300

# 只有这些字段落盘。必须和前端 store.js 的 PERSISTED_KEYS 一致。
# 侧栏宽度、当前视图、拖拽出来的高度这些是会话状态 —— 刷新就该重置，不存。
PERSISTED_KEYS = (
    'projects',
    'environments',
    'activeEnvId',
    'activeUserId',
    'settings',
    'history',
    # 每个方案最近一次跑完的结果（精简版，不含响应体）。
    # 跑 200 行要几分钟，刷新一下全没了太亏 —— 但也不能存响应体，
    # 见前端 store.js 的 slimRun。
    'planRuns',
)

# 后端自己维护的元字段：前端只管 version（它知道自己是哪个版本写的），
# revision 由后端每次写入自增，用来发现「另一个实例也改过这份数据」。
META_KEYS = ('version', 'revision')

# 读写锁：Flask 是多线程的，两个请求同时写会互相踩
_lock = threading.Lock()


def _warn(message: str) -> None:
    """打警告。打包成无控制台的 exe（PyInstaller windowed）后 sys.stdout / stderr
    是 None，直接 print 会先把自己崩了 —— 容错路径反倒成了新的崩溃点。"""
    try:
        print(f'[warn] {message}', file=sys.stderr)
    except Exception:
        pass

_EMPTY = {
    'projects': [],
    'environments': [],
    'activeEnvId': '',
    'activeUserId': '',
    'settings': {},
    'history': [],
    # 按方案 id 存「最近几次运行」的对象，不是数组 —— 类型错了的话，
    # _read_unlocked 的 isinstance 校验会把存档里的 dict 判成「类型不符」，
    # 历次运行记录整份丢掉
    'planRuns': {},
    'version': SCHEMA_VERSION,
    'revision': 0,
}


def _blank() -> dict:
    """返回一份全新的空结构。

    必须深拷贝：直接把 _EMPTY 交出去，调用方一改就把模板污染了。
    """
    return json.loads(json.dumps(_EMPTY))


def base_dir() -> str:
    """可写目录。

    打包成 exe 后是 exe 所在目录，开发时是项目根目录。
    不能用 PyInstaller 的 _MEIPASS —— 那是每次启动都会重建的临时解包目录，写进去会丢。
    """
    if getattr(sys, 'frozen', False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def data_file() -> str:
    return os.path.join(base_dir(), 'data', 'data.json')


def backup_dir() -> str:
    return os.path.join(base_dir(), 'data', 'backups')


def load() -> dict:
    """读数据。

    文件不存在、内容损坏、又不是个对象 —— 一律退回空结构，
    不让一份坏存档把整个工具卡在打不开的状态。
    """
    with _lock:
        return _read_unlocked()


def _read_unlocked() -> dict:
    """真正读文件。**调用方必须已经持有 _lock。**

    单独拆出来是给 save() 用的：那边要「读 → 改 → 写」一气呵成，中途不能放锁。
    """
    path = data_file()
    if not os.path.exists(path):
        return _blank()
    try:
        with open(path, 'r', encoding='utf-8') as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        _warn(f'数据文件读不出来（{e}），本次以空数据启动。原文件保留在：{path}')
        return _blank()

    if not isinstance(raw, dict):
        return _blank()

    data = _blank()
    for key in PERSISTED_KEYS + META_KEYS:
        value = raw.get(key)
        # 逐个校验类型：手改坏的字段（注释里说「肉眼就能改回来」，说明手改是预期场景）
        # 不退回默认的话，会原样透传给前端，前端的 .map / .length 直接崩
        if value is not None and isinstance(value, type(data[key])):
            data[key] = value

    # 不认识的顶层键原样留着：可能是更新的版本写的，也可能是手工加的。
    # 丢了它们就等于「老版本打开一次，新字段全没了」—— 只覆盖自己认识的 key
    # 才是这个文件该有的行为。
    for key, value in raw.items():
        if key not in data:
            data[key] = value
    return data


def _backup_unlocked() -> None:
    """把当前磁盘上的存档留一份。**调用方必须已经持有 _lock。**

    整个工具的全部价值就是那个 JSON 文件，而「误删一个项目」紧接着自动保存是
    不可逆的（项目 JSON 导出是手动挡）。所以在真正改盘之前先留一份。

    两条克制的规则，免得刷出一屋子备份：隔不到 BACKUP_MIN_GAP_SECONDS 就跳过；
    只保留最近 BACKUP_KEEP 份。
    """
    path = data_file()
    if not os.path.exists(path):
        return  # 还没有存档，没什么可备的

    directory = backup_dir()
    try:
        os.makedirs(directory, exist_ok=True)
        existing = sorted(
            name
            for name in os.listdir(directory)
            if name.startswith('data-') and name.endswith('.json')
        )
        if existing:
            newest = os.path.join(directory, existing[-1])
            if time.time() - os.path.getmtime(newest) < BACKUP_MIN_GAP_SECONDS:
                return

        target = os.path.join(directory, f'data-{time.strftime("%Y%m%d-%H%M%S")}.json')
        shutil.copyfile(path, target)

        # 文件名是 data-YYYYMMDD-HHMMSS.json，字典序就是时间序
        for name in sorted(os.listdir(directory))[:-BACKUP_KEEP]:
            if name.startswith('data-') and name.endswith('.json'):
                try:
                    os.unlink(os.path.join(directory, name))
                except OSError:
                    pass
    except OSError as e:
        # 备份失败不能连累保存 —— 主流程照走
        _warn(f'自动备份失败（不影响保存）：{e}')


def save(payload: dict):
    """整份覆盖写。

    @returns 成功时 `{'revision': n}`；**发现别处改过时返回 None**（调用方回 409）。
        以前这里把整份数据回传给前端，前端只检查状态码 —— 白传一份。

    先写同目录的临时文件再原子替换 —— 万一写到一半断电，坏的是临时文件，
    原存档还是完整的。单机工具，这种小成本换「数据不会莫名没了」很划算。
    """
    path = data_file()
    directory = os.path.dirname(path)

    # 读-改-写整段持锁，而不是只锁住写文件那一步。
    # 只锁写的话，两个并发 PUT 会各自读到同一份旧数据，各自改一处，
    # 后写的那个把先写的修改悄悄盖掉（丢失更新）。
    with _lock:
        # 以磁盘上的现有内容为底，只覆盖这次提交上来的字段，
        # 避免前端只想改一个字段却把别的字段清空
        data = _read_unlocked()

        # 冲突检测：调用方带上它读到时的 revision，与盘上的对不上就是别人写过。
        # 不带（手工 curl、老版本前端）就不查，保持原来「照写」的行为。
        base = payload.get('baseRevision') if isinstance(payload, dict) else None
        if not (isinstance(payload, dict) and payload.get('force')) and isinstance(base, int):
            if base != data.get('revision'):
                return None

        if isinstance(payload, dict):
            for key in PERSISTED_KEYS:
                if key in payload:
                    data[key] = payload[key]
            if isinstance(payload.get('version'), int):
                data['version'] = payload['version']

        if isinstance(data.get('history'), list):
            data['history'] = data['history'][:MAX_HISTORY]

        data['revision'] = int(data.get('revision') or 0) + 1

        _backup_unlocked()

        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=directory, suffix='.tmp')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                # 没有这一步，断电时 tmp 的内容可能还在页缓存里没落盘，
                # replace 过去的就是空壳 —— 「坏的是临时文件」的前提就没了
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

        return {'revision': data['revision']}
