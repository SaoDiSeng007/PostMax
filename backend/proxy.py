"""请求转发。

原则是「收到什么就原样转出去」：只决定 URL、header 和 body，
不解析 body —— JSON、文本、二进制在这里走的是同一段代码。
好处不只是省事：一旦反序列化再序列化，数字精度和格式（缩进、键顺序、
转义方式）都会悄悄被改掉，那这个工具就没法用来验证接口实际收到的是什么。
"""
from __future__ import annotations

import errno
import socket
import threading
import time
from urllib.parse import urlparse

import requests
import urllib3
from requests.adapters import HTTPAdapter
from requests.structures import CaseInsensitiveDict
from urllib3.connection import HTTPConnection, HTTPSConnection
from urllib3.connectionpool import HTTPConnectionPool, HTTPSConnectionPool

# 关掉「跳过证书校验」时的控制台警告：界面上本来就有明确的开关，
# 每发一次请求刷一屏警告纯属噪音
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

DEFAULT_TIMEOUT_MS = 30000

# 单次请求的超时上限：超过这个就不像「超时」了，更像挂在那儿不动
MAX_TIMEOUT_MS = 600000

# 响应体只保留前这么多字节。
# 这个工具是拿来看接口的，不是下载器：一个几百 MB 的响应会把后端内存顶起来，
# 再经过 JSON 序列化和前端渲染，最后多半是把标签页卡死。
# 超出的部分不显示，但会在界面上明确告知，不是静默丢弃。
MAX_BODY_BYTES = 10 * 1024 * 1024

# 为了算出「响应到底多大」而继续读的上限。
#
# 只保留 10MB 的话，界面上那句「完整大小 XX」就得靠继续读才知道。但一个 500MB 的文件
# 再读下去，用户等的是流量而不是结果 —— 到这儿打住，界面上说明「只统计到 50MB」。
MAX_READ_BYTES = 50 * 1024 * 1024

# 读取阶段的总时长上限（秒）。
#
# requests 的 timeout 管的是「两次数据之间」的间隔：一个一秒滴一个字节的服务
# 能永远吊着它，界面就一直转。所以再加一道墙钟总时长，到点就中止，返回已经读到的部分。
READ_DEADLINE_SECONDS = 20

# 这些 header 不照抄用户填的值，交给 requests 自己算：
#   host / content-length  跟着实际连接走，照抄会导致请求异常
#   accept-encoding        照抄的话 requests 不会自动解压，响应会变成一堆乱码字节
SKIP_HEADERS = {
    'host',
    'content-length',
    'accept-encoding',
    'connection',
    'transfer-encoding',
    'upgrade',
    'keep-alive',
    'te',
    'trailer',
    'proxy-authorization',
    'proxy-authenticate',
}


class ProxyError(Exception):
    """转发失败。消息会直接显示在界面上，所以说人话、并且尽量给出下一步。"""


def _header_out(value: str) -> str:
    """发送前的 header 值处理。

    HTTP 规范规定 header 只能是 ASCII，但「中文请求头」在实践中相当常见，
    Postman / curl 也照发不误。这里跟随它们的做法：把非 ASCII 字符按 UTF-8
    编码成字节再塞进 latin-1 字符串 —— 底层发出去的就是 UTF-8 字节，
    服务端按 UTF-8 解码就能拿到原文。
    """
    try:
        value.encode('latin-1')
        return value
    except UnicodeEncodeError:
        return value.encode('utf-8').decode('latin-1')


def _header_in(value: str) -> str:
    """展示 header 时用的反向转换。

    普通 ASCII 值原样返回；被上面转过的中文会被还原成可读文本。
    本来就合法的 latin-1 值（比如 café）解不出来，这时退回原文，不会弄坏它。
    """
    try:
        return value.encode('latin-1').decode('utf-8')
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value


# ---------------------------------------------------------------------------
# 让「终止」能真的掐断上游请求
#
# 前端点终止，断开的只是「浏览器 → 本地后端」这一跳。本地后端到被测服务的那次
# 请求还在飞 —— 被测服务照常把它做完，日志里也留着。要真断掉，得知道那个上游
# socket 在哪，然后把它关掉。
#
# 两个卡点都是实测出来的，不是想当然：
#
#   · http.client 拿到 socket 之后走的是 sock.makefile('rb')，此后所有读取都发生在
#     那个文件对象里。makefile 会给 socket 的 _io_refs 加一，于是 close() 只置一个
#     标记、不真关 fd（真正的 closesocket 要等文件对象关掉）—— 而阻塞中的读就在
#     文件对象里，等不到。所以唤醒必须用 _real_close()。
#   · requests 只在响应头回来之后才把响应交出来，在那之前根本摸不到连接。所以连接
#     类要换掉，让它在「刚连上」的时候就登记自己的 socket。
# ---------------------------------------------------------------------------

# 等上游回来的同时，隔这么久看一眼客户端还在不在。
# 太大：点了终止要等半天才断；太小：白烧 CPU
WATCH_INTERVAL_SECONDS = 0.15


class ClientGone(Exception):
    """客户端（浏览器）已经断开 —— 一般是用户点了「终止」。"""


def _kill_socket(sock) -> None:
    """把上游 socket 关掉。

    必须走 _real_close()：http.client 用 makefile 读过它，_io_refs 不为 0，
    close() 只会置个标记，阻塞中的读不会醒（Windows 上实测如此，一关就醒，
    close 则一直等到超时）。
    """
    if sock is None:
        return
    try:
        sock._real_close()  # noqa: SLF001 —— 只有它能让阻塞的读立刻返回
    except Exception:
        try:
            sock.close()
        except Exception:
            pass


class _LiveConnection:
    """这一轮转发用到的上游 socket。终止时把它们全掐掉。"""

    def __init__(self):
        self._sockets = []
        self._aborted = False
        self._lock = threading.Lock()

    def remember(self, sock):
        with self._lock:
            if self._aborted:
                # 已经在关了：这会儿才连上的也顺手掐掉，不然它会从缝里溜过去
                _kill_socket(sock)
                return
            self._sockets.append(sock)

    def forget(self, sock):
        if sock is None:
            return
        with self._lock:
            if sock in self._sockets:
                self._sockets.remove(sock)

    def abort(self):
        with self._lock:
            self._aborted = True
            sockets, self._sockets = list(self._sockets), []
        for sock in sockets:
            _kill_socket(sock)


def _tracked_connection(base, live):
    """造一个「刚连上就登记自己」的连接类。

    每个转发的 session 是单独建的、连接池也归它自己，所以按调用把 live 绑进闭包
    不会有并发串台的问题。
    """

    class Tracked(base):
        def connect(self):
            super().connect()
            live.remember(self.sock)

        def close(self):
            live.forget(getattr(self, 'sock', None))
            super().close()

    return Tracked


def _swap_connection_cls(pool, live):
    """把连接池用的连接类换成「会登记自己」的那个。"""
    if isinstance(pool, HTTPSConnectionPool):
        pool.ConnectionCls = _tracked_connection(HTTPSConnection, live)
    elif isinstance(pool, HTTPConnectionPool):
        pool.ConnectionCls = _tracked_connection(HTTPConnection, live)
    return pool


class _AbortableAdapter(HTTPAdapter):
    """把池子里用的连接类换成会登记自己的那种。

    两个入口都要挂：requests 2.32 起走 `get_connection_with_tls_context`，
    之前走 `get_connection`。只挂一个，另一个版本上就是**悄悄不生效** ——
    终止时一个 socket 都登记不到，掐断等于没做。这种「静默失效」最该用测试钉住，
    见 tests/test_proxy.py 的 TestAbort。
    """

    def __init__(self, live, **kwargs):
        self._live = live
        super().__init__(**kwargs)

    def get_connection_with_tls_context(self, request, verify, proxies=None, cert=None):
        return _swap_connection_cls(
            super().get_connection_with_tls_context(request, verify, proxies, cert),
            self._live,
        )

    def get_connection(self, url, proxies=None):
        return _swap_connection_cls(super().get_connection(url, proxies), self._live)


def _run_upstream(session, prepared, *, timeout, verify, follow, live, client_check, holder):
    """发请求 + 读响应体，结果写进 holder。

    给了 client_check 就把它放到别的线程跑，主线程每隔一会儿看一眼客户端还在不在 ——
    还在就接着等，走了就把上游连接掐掉、立刻收工。没给（单测、直接调用）就同步跑，
    行为和以前完全一样。
    """
    done = threading.Event()

    def work():
        try:
            holder['resp'] = session.send(
                prepared,
                timeout=timeout,
                verify=verify,
                allow_redirects=follow,
                # 流式拿响应体：下面只取前 MAX_BODY_BYTES 字节，
                # 不流式的话 requests 会先把整个响应读完再交给我们
                stream=True,
            )
            holder['read'] = _read_body(holder['resp'])
        except BaseException as e:  # noqa: BLE001 —— 原样带回去按类型处理
            holder['error'] = e
        finally:
            done.set()

    if client_check is None:
        work()
    else:
        threading.Thread(target=work, daemon=True, name='postmax-upstream').start()
        while not done.wait(WATCH_INTERVAL_SECONDS):
            if client_check():
                live.abort()
                # 给它一点时间从阻塞里退出来，然后不再等
                done.wait(1.0)
                raise ClientGone()

    if holder.get('error') is not None:
        raise holder['error']


def forward(payload: dict, client_check=None) -> dict:
    """执行一次转发，返回前端要的响应结构。

    @param client_check 调用方给的「客户端还在不在」的判断（见 app.py）。
        给了才具备「终止时掐断上游」的能力；不给就同步跑完，行为不变。
    """
    method = str(payload.get('method') or 'GET').upper()
    url = str(payload.get('url') or '').strip()
    body = payload.get('body') or ''
    raw_headers = payload.get('headers') or []

    if not url:
        raise ProxyError('请求地址是空的。')

    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https'):
        hint = f'可能是漏了 https:// 前缀。' if parsed.scheme == '' else ''
        raise ProxyError(f'只支持 http / https，当前是「{url}」。{hint}')

    header_pairs = _clean_headers(raw_headers)
    timeout_seconds = _timeout_seconds(payload.get('timeout'))
    verify = _flag(payload.get('verifyTls'), default=True)
    follow = _flag(payload.get('followRedirects'), default=True)

    # 这次请求实际会经过哪个代理。requests 默认认环境变量里的 HTTP_PROXY /
    # HTTPS_PROXY，在 Windows 上还会读注册表里的系统代理 —— 用户在界面上没填过
    # 任何代理，于是「连不上」时他根本想不到还有这么一层。提前算出来，失败时
    # 才说得出口（见 _connect_hint）。
    proxy_url = _effective_proxy(url)

    # 用 PreparedRequest 走一遍，是为了拿到「真正发出去的 header」——
    # requests 会自动补 User-Agent / Accept / Content-Length 等，
    # 用户要看的是最终结果，不是自己填的那几行
    session = requests.Session()
    # 这一轮用到的上游连接。终止时前端会断开，后端据此把它们掐掉
    live = _LiveConnection()
    session.mount('http://', _AbortableAdapter(live))
    session.mount('https://', _AbortableAdapter(live))
    prepared = session.prepare_request(
        requests.Request(
            method=method,
            url=url,
            headers=header_pairs,
            data=body.encode('utf-8') if body else None,
        )
    )

    started = time.perf_counter()
    holder = {}
    resp = None
    try:
        # 响应体也在这条路里读：send 只等到响应头，body 传输中途的 超时 / 断连
        # （最常见的「读取超时」恰恰发生在这）和发请求阶段是同一类网络问题，
        # 得走同一套「说人话」的报错，不能漏到上层的兜底 500 去
        _run_upstream(
            session,
            prepared,
            timeout=timeout_seconds,
            verify=verify,
            follow=follow,
            live=live,
            client_check=client_check,
            holder=holder,
        )
        resp = holder['resp']
        read = holder['read']
    except requests.exceptions.SSLError as e:
        raise ProxyError(f'TLS 证书校验没通过：{_brief(e)}。自签证书的测试环境可以勾选「跳过证书校验」。') from e
    except requests.exceptions.ConnectTimeout as e:
        raise ProxyError(
            f'连接超时（{_fmt_seconds(timeout_seconds)}）：连不上 {parsed.hostname}。'
            f'{_proxy_note(proxy_url)}'
        ) from e
    except requests.exceptions.ReadTimeout as e:
        raise ProxyError(f'读取响应超时（{_fmt_seconds(timeout_seconds)}）：服务器一直没返回数据。') from e
    except requests.exceptions.TooManyRedirects as e:
        raise ProxyError('重定向次数过多，可能是循环重定向。') from e
    except requests.exceptions.InvalidURL as e:
        raise ProxyError(f'URL 格式不对：{_brief(e)}') from e
    except requests.exceptions.ConnectionError as e:
        raise ProxyError(_connect_hint(e, parsed, proxy_url)) from e
    except requests.exceptions.RequestException as e:
        raise ProxyError(f'请求失败：{_brief(e)}') from e
    finally:
        # 用 holder 而不是局部 resp：读响应体中途出错时 resp 其实已经拿到手了，
        # 也得关掉（以前是同一份，改成两段之后别漏了）
        if holder.get('resp') is not None:
            holder['resp'].close()
        session.close()

    # 耗时要算到 body 读完 —— 只算到响应头的话，一个慢速大响应会显示「80ms / 30MB」，
    # 和 size（整个 body 的字节数）口径对不上，两个数字拼在一起是误导
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    return {
        'request': {
            'method': prepared.method,
            'url': prepared.url,
            'headers': [
                {'key': _header_in(k), 'value': _header_in(v)}
                for k, v in prepared.headers.items()
            ],
            'body': _body_text(prepared.body),
        },
        'status': resp.status_code,
        'statusText': resp.reason or '',
        'time': elapsed_ms,
        'size': read['total'],
        'headers': [{'key': k, 'value': _header_in(v)} for k, v in _response_headers(resp)],
        'body': _decode(resp, read['body']),
        # 下面这几个是给界面判断怎么说话用的（见 frontend ResponsePanel 的 truncateNotice）：
        #   truncated     保留的部分被截了：body 只有开头一段，size 是真实大小
        #   readTimedOut  读满 READ_DEADLINE_SECONDS 还没下完，主动中止
        #   readCapped    为了算 size 一直读到 MAX_READ_BYTES 打住
        'truncated': read['total'] > MAX_BODY_BYTES,
        'readTimedOut': read['timedOut'],
        'readCapped': read['readCapped'],
        'bodyLimit': MAX_BODY_BYTES,
        'readLimit': MAX_READ_BYTES,
        'readDeadline': READ_DEADLINE_SECONDS,
    }


def _clean_headers(raw_headers) -> CaseInsensitiveDict:
    """只保留有 key 的 header，并剔掉那些不该由用户决定的。

    用 CaseInsensitiveDict 而不是普通 dict：requests 要的本来就是这玩意儿，
    而且 `X-Token` 和 `x-token` 会被认成同一个 header，
    不会出现用户填了两行大小写不同的同一个头、结果真的发两条出去。
    """
    cleaned = CaseInsensitiveDict()
    for item in raw_headers:
        if not isinstance(item, dict):
            continue
        key = str(item.get('key') or '').strip()
        if not key or key.lower() in SKIP_HEADERS:
            continue
        # header **名**只能是 ASCII —— 这是 HTTP 规范（field-name = token），不是
        # 我们挑刺：Python 的 http.client 对名字硬编码 encode('ascii')，绕不过去。
        # 不在这里拦的话，用户看到的是一句 500 里的编码异常，跟「我填错了什么」
        # 毫无关系。值不一样：中文值实践中到处都在用，下面照旧放行。
        if not key.isascii():
            raise ProxyError(
                f'header 名「{key}」不是 ASCII。HTTP 规范要求 header 名只能是字母、数字'
                '和少数符号 —— 中文放不进名字里，放进值里是可以的。'
            )
        cleaned[key] = _header_out(str(item.get('value') or ''))
    return cleaned


def _response_headers(resp) -> list:
    """响应头。

    必须用 iteritems() 而不是 items()：resp.headers 和 resp.raw.headers 都是
    类 dict 容器，items() 会把同名的头（多个 Set-Cookie 很常见）合并成一个
    逗号串，登录接口上很容易看错。iteritems() 才是逐条吐出、不做合并的那个。
    """
    try:
        headers = resp.raw.headers
        pairs = headers.iteritems() if hasattr(headers, 'iteritems') else headers.items()
        return list(pairs)
    except Exception:
        return list(resp.headers.items())


def _read_body(resp) -> dict:
    """读响应体。分块读，峰值内存是单个 chunk 而不是整个响应。

    三档限制，都是为了「别为了一个下载把界面卡死」：
      1. 只保留前 MAX_BODY_BYTES 字节（超出不再往内存里放，但还会继续读，见下）；
      2. 为了算出 total 继续读，最多读到 MAX_READ_BYTES 就打住；
      3. 整个读取阶段最多花 READ_DEADLINE_SECONDS，到点中止。

    任何一种提前停下都在返回值里说清楚，界面据此解释「为什么只看到一段」，
    不静默丢。

    @returns {{body: bytes, total: int, timedOut: bool, readCapped: bool}}
    """
    kept = bytearray()
    total = 0
    started = time.monotonic()
    timed_out = False
    read_capped = False

    for chunk in resp.iter_content(65536):
        if not chunk:
            continue
        total += len(chunk)
        if len(kept) < MAX_BODY_BYTES:
            kept.extend(chunk[: MAX_BODY_BYTES - len(kept)])

        if total >= MAX_READ_BYTES:
            read_capped = True
            break
        if time.monotonic() - started >= READ_DEADLINE_SECONDS:
            timed_out = True
            break

    return {
        'body': bytes(kept),
        'total': total,
        'timedOut': timed_out,
        'readCapped': read_capped,
    }


def _decode(resp, raw: bytes) -> str:
    """把响应体解成文本。

    响应头里没写 charset 时，requests 会按 ISO-8859-1 解码，中文直接变乱码，
    所以先按 UTF-8 试一把。

    不用 resp.apparent_encoding —— 它需要完整响应体才能猜，而这里拿到的可能
    只是开头一段（响应本身有保留上限），猜出来的结果也不可信。
    """
    content_type = resp.headers.get('content-type', '').lower()
    if 'charset' not in content_type:
        try:
            return raw.decode('utf-8')
        except UnicodeDecodeError:
            pass
    # 解不出来的字节用替换符顶上，不至于整个响应报错
    return raw.decode(resp.encoding or 'utf-8', errors='replace')


def _body_text(body) -> str:
    if body is None:
        return ''
    if isinstance(body, bytes):
        return body.decode('utf-8', errors='replace')
    return str(body)


def _timeout_seconds(value) -> float:
    # bool 是 int 的子类，float(True) 会得到 1.0（= 1 毫秒），先把它挡在门外，
    # 否则一个手滑的 true 会让请求必然超时、报错还指向「连接超时」误导排查
    if isinstance(value, bool):
        return DEFAULT_TIMEOUT_MS / 1000.0
    try:
        ms = float(value)
    except (TypeError, ValueError):
        ms = DEFAULT_TIMEOUT_MS
    if ms <= 0:
        ms = DEFAULT_TIMEOUT_MS
    # 夹个上限：再大的「超时」就不是超时了，线程会被吊到地老天荒
    return min(ms, MAX_TIMEOUT_MS) / 1000.0


def _flag(value, default: bool) -> bool:
    return default if value is None else bool(value)


def _fmt_seconds(seconds: float) -> str:
    return f'{seconds:g} 秒'


def _brief(error: Exception) -> str:
    """异常信息压成一行：requests 的报错常常带一长串堆栈味的前缀。"""
    text = str(error).strip().replace('\n', ' ')
    return text.split('(Caused by')[0].strip() or error.__class__.__name__


def _where(parsed) -> str:
    """报错里得说清是哪台机器 —— 只说「连不上」等于没说。"""
    host = parsed.hostname or ''
    try:
        port = parsed.port
    except ValueError:
        port = None
    if port:
        return f'{host}:{port}'
    return host or '目标地址'


def _root_cause(error: Exception):
    """顺着异常链往下找最底层那个，判断「为什么连不上」：'dns' / 'refused' / 'timeout'。

    不能只看异常文本：requests 那串消息里带的原因可能是本地化的（Windows 上是
    「由于目标计算机积极拒绝，无法连接。」之类），按文字匹配一换系统语言就失效。

    也不能按 `errno` 常量硬比：`errno.ENOTFOUND` 在 Windows 上根本不存在，写
    `code == errno.ENOTFOUND` 会在错误处理路径上抛 AttributeError —— 本来只是
    「连不上」，最后报出来的是工具自己崩了。域名解析失败一律认 `socket.gaierror`
    （它在各平台都是同一个类），这个才可靠。
    """
    current = error
    for _ in range(10):
        if current is None:
            return ''
        if isinstance(current, socket.gaierror):
            return 'dns'
        if isinstance(current, OSError) and current.errno:
            if current.errno == errno.ECONNREFUSED:
                return 'refused'
            if current.errno == errno.ETIMEDOUT:
                return 'timeout'
        current = current.__cause__ or current.__context__
    return ''


def _chain_text(error: Exception) -> str:
    """整条异常链的文字拼起来（小写）。

    真正的原因常常压在 `__cause__` 里，只看最外层那串是看不出来的 ——
    requests 的 ConnectionError 外面写着「Max retries exceeded」，
    「Connection refused」在里面那一层。
    """
    parts = []
    current = error
    for _ in range(10):
        if current is None:
            break
        parts.append(str(current))
        current = current.__cause__ or current.__context__
    return ' '.join(parts).lower()


def _effective_proxy(url: str) -> str:
    """这次请求实际会经过哪个代理；没有就返回空串。

    requests 默认认环境变量里的 HTTP_PROXY / HTTPS_PROXY，Windows 上还会读
    注册表里的系统代理设置。这两处都不在界面上，用户填完地址点发送，根本不知道
    中间还有一跳 —— 所以连接失败时必须能把它说出来，否则「连不上 127.0.0.1：
    对方拒绝连接（服务没起来，或者端口不对）」会把人往完全错误的方向引
    （实测踩过：目标服务好端端的，是代理那一跳死了）。

    用 requests 自己的判断，而不是直接读 os.environ：这样 no_proxy 例外、
    系统代理设置这些规则都跟真正发包时用的那一套保持一致，不会两处口径打架。
    """
    try:
        proxies = requests.utils.get_environ_proxies(url)
    except Exception:
        return ''
    return proxies.get('https') or proxies.get('http') or ''


def _proxy_note(proxy_url: str) -> str:
    """「这次不是直连」的补充说明。没走代理就返回空串，不啰嗦。"""
    if not proxy_url:
        return ''
    return (
        f' 这次请求是经代理 {proxy_url} 发出去的 —— 它来自环境变量 HTTP_PROXY / '
        'HTTPS_PROXY（或系统代理设置），不是界面上填的。'
    )


def _connect_hint(error: Exception, parsed, proxy_url: str = '') -> str:
    """
    把连接类异常翻成一句人话。

    以前是直接把 requests 的原文贴出去，用户看到的是
    「连不上服务器：HTTPConnectionPool(host='127.0.0.1', port=59999):
    Max retries exceeded with url: /nope」—— 库的类名和内部结构，跟「我该
    改哪儿」毫无关系。而这句话会原样进自动化报告和失败摘要，被反复读。

    @param proxy_url 这次请求走的代理（见 _effective_proxy）。非空时换一套说法：
        失败的其实是「到代理那一跳」，说成「对方拒绝连接」等于把锅扣在被测服务上。
    """
    where = _where(parsed)
    cause = _root_cause(error)

    if proxy_url:
        # 有代理时不再说「对方拒绝连接（服务没起来…）」—— 那个「对方」到底是
        # 代理还是目标，用户分不出来，而这一句会直接决定他接下来去查什么
        reason = {
            'dns': '域名解析不了',
            'refused': '代理拒绝了连接',
            'timeout': '连代理超时',
        }.get(cause, '')
        tail = f'（{reason}）' if reason else ''
        return (
            f'连不上 {where}：经代理 {proxy_url} 转发失败{tail}。'
            f'{_proxy_note(proxy_url).strip()}'
            ' 目标服务本身可能是好的，先把这个代理关掉再试一次。'
        )

    if cause == 'dns':
        return f'连不上 {where}：域名解析不了。'
    if cause == 'refused':
        return f'连不上 {where}：对方拒绝连接（服务没起来，或者端口不对）。'
    if cause == 'timeout':
        return f'连不上 {where}：连接超时。'

    # 认不出类型时再退回文本，只认英文那几个最常见的写法
    lowered = _chain_text(error)
    if 'name or service not known' in lowered or 'nodename nor servname' in lowered:
        return f'连不上 {where}：域名解析不了。'
    if 'refused' in lowered:
        return f'连不上 {where}：对方拒绝连接（服务没起来，或者端口不对）。'
    return f'连不上 {where}。'
