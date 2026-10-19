# PostMax 桌面版（Tauri 外壳）

把 PostMax 打包成一个双击就开的 Windows 应用：**不需要装 Python，也不需要另开浏览器**。

## 它是怎么拼起来的

```
Tauri 外壳 (Rust)  ──启动子进程──>  postmax-backend.exe (PyInstaller + Flask)
      │                                    │
      └──窗口加载 http://127.0.0.1:<port>───┘
```

- **后端就是原来那份 Python**，一行业务逻辑没改：转发请求、掐断上游、读写 JSON 存档。
- **外壳只干三件事**：开窗口 → 起后端 → 等端口通了把窗口指向它。
- 界面走的是 `http://127.0.0.1`，和浏览器版同源，所以前端不用改一行（相对路径 `fetch('/api/...')` 照常）。
- 端口由外壳用「让系统分配」的方式挑，不写死，避免和别的实例撞车。

## 目录

```
packaging/
├─ 打包.bat                # 双击入口（纯 ASCII，只负责转给下面的 ps1）
├─ packaging.ps1           # 全部逻辑：体检 / 打包 / 清理 / 打开产物
├─ package.json            # 只有 @tauri-apps/cli 一个依赖
├─ build-backend.mjs       # 把 ../run.py 打成 sidecar exe
├─ make-portable.mjs       # 组装免安装版并压 zip
├─ ui/index.html           # 启动时的加载页（后端准备好之前显示的）
└─ src-tauri/
   ├─ src/main.rs          # 外壳逻辑：挑端口 / 起后端 / 开窗口 / 退出时收尸
   ├─ tauri.conf.json      # 打包配置（NSIS 安装包，按当前用户安装，不需要管理员）
   ├─ icons/               # 由 ../frontend/favicon.svg 生成
   └─ binaries/            # ← build-backend.mjs 的产物落这里
```

## 需要装什么（只装一次）

| 工具 | 干什么用 | 怎么装 | 验证 |
| --- | --- | --- | --- |
| **Node.js 18+**（推荐 22 LTS） | 跑打包脚本、提供 Tauri CLI | [nodejs.org](https://nodejs.org/) 或 `winget install OpenJS.NodeJS.LTS` | `node -v` |
| **Rust**（rustup） | 编译桌面外壳本体 | [rustup.rs](https://rustup.rs/) 下载 `rustup-init.exe`，直接回车用默认 | `cargo -V` |
| **VS 2022 Build Tools**<br>勾「使用 C++ 的桌面开发」 | 提供 MSVC 编译器和 Windows SDK | `winget install Microsoft.VisualStudio.2022.BuildTools` | `打包.bat check` 里看到 `[ok] MSVC` |
| **Python 3.10+** | 把后端打成 exe | [python.org](https://www.python.org/) 装时**勾上 Add to PATH** | `python -V` |
| **WebView2 运行时** | 只有**运行**需要，打包不需要 | Win11、Win10 1803+ 已自带 | 打开程序看有没有窗口 |

> **MSVC 是硬性的**：Tauri 只支持 `x86_64-pc-windows-msvc`，它的 WebView2 绑定直接链 `WebView2LoaderStatic.lib` 和 MSVC 运行库，GNU 工具链编不过，没有绕过的办法。

**磁盘**：大约 4 GB（MSVC + SDK 约 3.5 GB，Rust 工具链约 0.5 GB，`target` 编译产物约 1.2 GB）。

装完**一定要开一个新的命令行窗口**，否则 PATH 还是旧的（尤其是 Rust 和 Python）。

## 打包

双击 `packaging\打包.bat`，按序号选；也可以在命令行直接指定：

```
打包.bat              安装包 + 免安装版（默认）
打包.bat installer    只出安装包
打包.bat portable     只重打免安装版（前提：之前打过包）
打包.bat check        只体检工具链
打包.bat clean        清 dist 和中间产物
```

脚本干这四步：

```
[1/4] 检查 node / npm / cargo / MSVC / Python / WebView2 / NSIS
[2/4] 建或复用 packaging\.venv，装 flask requests pyinstaller
[3/4] 缺 node_modules 就 npm install（只有 @tauri-apps/cli 一个依赖）
[4/4] node build-backend.mjs   → PyInstaller 把 run.py 打成后端 exe
      npx tauri build          → 编译外壳 + 出 NSIS 安装包
      node make-portable.mjs   → 拷 exe、放 portable.flag、压 zip
```

三个子步骤的分工：

- **`build-backend.mjs`**：用 PyInstaller 把整个 Python 后端（含 `frontend/` 静态文件）打成单文件 `postmax-backend.exe`，放到 `src-tauri/binaries/` 等 Tauri 取用。
- **`tauri build`**：编 Rust 外壳，把后端 exe 作为 sidecar 塞进安装包，出 NSIS 安装程序。
- **`make-portable.mjs`**：从 `target/release/` 拷 `postmax.exe` + `postmax-backend.exe`，加一个 `portable.flag`（有这个文件就切便携模式，数据写程序目录），打包成 zip。

产物：

| 产物 | 路径 |
| --- | --- |
| 安装包 | `src-tauri\target\release\bundle\nsis\PostMax_1.0.0_x64-setup.exe` |
| 免安装版压缩包 | `dist\PostMax-1.0.0-portable.zip` |

版本号在 `src-tauri\tauri.conf.json` 的 `version` 改，安装包名和 `dist` 目录名会自动跟着变。

### 不用 bat 的话

```bash
cd packaging
python -m venv .venv
.venv/Scripts/pip install -r ../requirements.txt pyinstaller
npm install

node build-backend.mjs
npx --no-install tauri build
node make-portable.mjs          # 只有要免安装版才需要
```

## 便携版 vs 安装版

同一份 `postmax.exe`，区别只是 **exe 旁边有没有 `portable.flag`**：

| | 安装版 | 便携版 |
| --- | --- | --- |
| 数据 | `%APPDATA%\PostMax\` | exe 同目录（`data\`、日志都在里面） |
| 快捷方式 / 卸载入口 | 有 | 无，手动删文件夹 |
| WebView2 缺失 | 安装时自动装 | **不会装**，起不来（先去装运行时） |

便携模式由 `backend/storage.py` 的 `is_portable()` 判定，外壳的日志目录用同一套规则（`data_dir()`），两边不会分家。`POSTMAX_DATA_DIR` 环境变量优先级最高，可以压过这两者。

`npm run build` / `npm run portable` 仍然可用，等价于 bat 里的对应步骤。

免安装包里有 `postmax.exe` + `postmax-backend.exe` + `portable.flag` + `使用说明.txt`。**两个 exe 必须同目录**，`postmax.exe` 可以改名，`postmax-backend.exe` 不行（外壳按固定名字找 sidecar）。

## 数据和日志在哪

安装版把存档放在用户目录，**不放在安装目录**（安装目录普通用户写不进去，放那儿会出现「装完第一次保存就失败」）；便携版（exe 旁有 `portable.flag`）则全部落在 exe 同目录，整个文件夹拷走就带走一切。

| 内容 | 安装版 | 便携版 |
| --- | --- | --- |
| 存档 | `%APPDATA%\PostMax\data\data.json` | `<程序目录>\data\data.json` |
| 自动备份 | `%APPDATA%\PostMax\data\backups\` | `<程序目录>\data\backups\` |
| 外壳日志 | `%APPDATA%\PostMax\shell.log` | `<程序目录>\shell.log` |
| 后端日志 | `%APPDATA%\PostMax\backend.log` | `<程序目录>\backend.log` |

和浏览器版（`<项目>/data/data.json`）是两份独立文件。想接着用浏览器版的数据，把那个 json 拷过去即可。

## 窗口尺寸

初始窗口取**屏幕工作区（已扣掉任务栏）的 0.75**，不是固定像素。1920×1080 开 125% 时约 1152×640 逻辑像素（外框约 1458×847 物理像素），占屏幕四分之三。

1. 取显示器工作区，除以缩放比例换算成逻辑像素；
2. 乘 0.75，再夹到合理区间（宽 980~1440、高 640~900），且不许超出可用区域；
3. 窗口建好后再拿「外框 − 客户区」的差值校准一次，把外框收进工作区并居中。

**最大化 / 还原**：`maximizable` + `resizable` 都开着，点最大化铺满工作区，点还原精确回到初始尺寸（实测 1516×847 → 1938×1038 → 1516×847）。

**想改初始大小**：设环境变量 `POSTMAX_WINDOW_SCALE`（0.4 ~ 1.0），越小窗口越小。

```bat
set POSTMAX_WINDOW_SCALE=0.65
postmax.exe
```

检测结果写在 `shell.log` 的 `[window]` 行（可用区域、初始尺寸、可拖到的下限），尺寸不对劲直接看这行。1366×768、150% 缩放、2K 屏走的是同一套逻辑。

## 排错

**窗口停在「正在启动本地服务…」** —— 后端没起来。看 `backend.log`（后端的真实报错都在里面）和 `shell.log`（外壳等到哪一步）；也可以到程序目录双击 `postmax-backend.exe`，控制台会直接报错。

> 日志文件由外壳自己写：后端是被管道拉起来的，它的 stdout 不会自己落到任何文件，`backend.log` 是外壳转存的。超过 512 KB 会自动重开。

**提示「后端进程启动失败」** —— 多半是杀毒软件把 `postmax-backend.exe` 拦了（PyInstaller 单文件 exe 容易被误判），加白名单即可。它只是个带 Python 运行时的 Flask 服务。

**`link.exe not found` / `note: msvc not found`** —— MSVC 没装或没生效。装 Visual Studio Build Tools 的「使用 C++ 的桌面开发」工作负载，**装完重开终端**。`打包.bat check` 能提前发现。

**编译时报 `WebView2` 相关错误** —— Windows 10 1803+ / Windows 11 自带 WebView2 运行时，老系统需要单独装。

**第一次编译要三到六分钟** —— 正常。几百个 crate 要从头编一遍，之后增量编译一两分钟。

**Rust 装不上 / `rustup-init.exe` 卡住** —— 换国内镜像再跑：

```
set RUSTUP_DIST_SERVER=https://mirrors.tuna.tsinghua.edu.cn/rustup
set RUSTUP_UPDATE_ROOT=https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup
rustup-init.exe
```

**`npm install` 很慢或报网络错**

```
npm install --registry=https://registry.npmmirror.com
```

**`pip` 很慢**

```
.venv\Scripts\pip install -r ..\requirements.txt pyinstaller -i https://pypi.tuna.tsinghua.edu.cn/simple
```

**VS Build Tools 装到一半反复重试、下不动** —— 本机 `aka.ms` 的 HTTPS 被 DNS 指到一个连不通的 CDN 节点，但 **HTTP 是通的**。稳妥做法是直接在[微软官网](https://visualstudio.microsoft.com/downloads/)下载 Build Tools 引导程序，或在能连的机器上下好离线包再用 `--layout` 装。

**`打包.bat` 在编辑器里打开是乱码 / 跑起来报「不是内部或外部命令」** —— 别再往 `.bat` 里写中文。含中文的 bat 只能存 GBK（编辑器按 UTF-8 打开就是乱），存成 UTF-8 又会让 cmd 按偏移读错行；加 `chcp` 切代码页也一样会错位。现在中文全在 `packaging.ps1`（UTF-8 with BOM），`.bat` 只有 5 行 ASCII，只负责把参数转过去。改逻辑改 ps1，别往 bat 里加字。

## 改代码后要重打包吗

| 改了什么 | 要做什么 |
| --- | --- |
| `frontend/` 里的界面 | 重打后端（界面文件是被后端发出去的）→ `打包.bat` |
| `backend/` 或 `run.py` | 同上，`打包.bat` |
| `src-tauri/src/main.rs`（外壳） | `打包.bat`（会一起重打后端，省心） |
| `tauri.conf.json`（版本号等） | `打包.bat` |
