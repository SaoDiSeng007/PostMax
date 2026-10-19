#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! PostMax 桌面外壳。
//!
//! 界面本身是「浏览器直接加载的无构建前端」，业务全在 Python 后端里（转发请求、
//! 掐断上游、读写 JSON 存档）。所以外壳干的活很窄：起一个窗口 → 把后端 exe 当子进程
//! 拉起来 → 等它开始监听 → 窗口直接加载 `http://127.0.0.1:<port>/index.html`。
//!
//! 两个关键取舍：
//!
//! 1. **窗口一开始就指向本地服务，而不是「先加载内置页面再跳转」**。
//!    Tauri 默认禁止从 tauri:// 源跳到远程源（安全策略），跳转会静默失败，
//!    表现就是窗口永远停在加载页。所以这里等后端就绪后才建窗口；
//!    内置的 ui/index.html 只在后端起不来时用来显示报错。
//! 2. **前端走本地 HTTP，而不是塞进 Tauri 的 tauri:// 协议**。
//!    前端用的是相对路径 fetch('/api/...')，和后端同源才不用处理跨域；
//!    换个协议就得改一遍前端，还得引入 CSP 豁免。保持「网页 + 本地服务」，
//!    浏览器版和桌面版跑的就是同一份代码。

use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// 后端进程句柄。窗口关掉时得掐掉它，否则 Flask 会留在后台占着端口 ——
/// 下次启动看着像成功了，其实连的是上一轮那个进程，数据目录还可能是旧的。
struct Backend(Mutex<Option<CommandChild>>);

/// 让系统挑一个空闲端口。
///
/// 不照搬 run.py 里「59721 往后数」的做法：内核给的端口不会被别人抢，
/// 也不会和用户自己手动起的那个实例撞上。
fn free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(59721)
}

/// 等后端把端口听起来。
///
/// 能连上就说明 listen() 已经调过，请求会排队等着被处理 —— 不用非等到 /api/health
/// 回 200，那一轮多等的时间纯粹是白等。
fn wait_ready(port: u16, timeout: Duration) -> bool {
    let addr = match format!("127.0.0.1:{port}").parse() {
        Ok(addr) => addr,
        Err(_) => return false,
    };
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// 便携模式标记文件，和后端 `storage.PORTABLE_MARKER` 必须一致。
///
/// 有这个文件 → 数据/日志都写在 exe 旁边（拷走文件夹就带走一切）；
/// 没有 → 走 %APPDATA%\PostMax（安装版，安装目录不可写）。
const PORTABLE_MARKER: &str = "portable.flag";

/// 数据目录。规则跟后端完全一致，否则日志和存档会分家。
fn data_dir() -> std::path::PathBuf {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    if let Some(dir) = exe_dir {
        if dir.join(PORTABLE_MARKER).exists() {
            return dir;
        }
    }
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    std::path::Path::new(&base).join("PostMax")
}

/// 往数据目录里的某个日志文件追加一行。
///
/// release 版是 windows 子系统，没有控制台，`println!` 出去就没了 ——
/// 用户报「双击没反应」时，唯一能查的就是这些文件。超过 512 KB 直接重开，
/// 免得没人管的日志长到几 MB。
fn append_log(name: &str, message: &str) {
    use std::io::Write;

    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(name);
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 512 * 1024 {
            let _ = std::fs::remove_file(&path);
        }
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{message}");
    }
}

/// 外壳自己的启动记录。
fn log(message: &str) {
    append_log("shell.log", message);
}

/// 后端输出。后端是被外壳拿管道拉起来的，它的 stdout 不会落到任何文件里 ——
/// 出了问题「后端为什么崩」就只能靠这里。Flask 的访问日志也在这儿。
fn log_backend(message: &str) {
    append_log("backend.log", message);
}

/// 初始窗口占工作区（扣掉任务栏那块）的比例。
///
/// 不用固定像素：同一组数字在 1080p 和小新笔记本上观感差太多，铺满屏幕又压抑。
/// 0.75 是「明显是个窗口、四周留得出桌面、内容还不挤」的那一档：
/// 1920×1080 开 125% 时约 1152×640，占屏幕四分之三，比铺满小一圈半。
/// 想自己调，设环境变量 `POSTMAX_WINDOW_SCALE`（0.4 ~ 1.0）。
const DEFAULT_RATIO: f64 = 0.75;
/// 初始尺寸的上限（逻辑像素）。再大的屏幕也别一上来就铺到 1440 以上。
const MAX_SIZE: (f64, f64) = (1440.0, 900.0);
/// 初始尺寸的下限（逻辑像素）。低于这个值，请求区和响应区就开始互相压了。
const INIT_MIN: (f64, f64) = (980.0, 640.0);
/// 用户手动拖拽能缩到的极限。比初始值小，留出「自己再拉小一点」的余地。
const DRAG_MIN: (f64, f64) = (900.0, 560.0);
/// 四周留白（逻辑像素）。不留的话窗口正好顶到任务栏和屏幕边缘，
/// 用户想拖窗口都抓不到标题栏。
const EDGE: f64 = 24.0;

/// 初始窗口比例，允许用环境变量覆盖。非法值一律回落到默认，不报错 ——
/// 这是个便利开关，写错了不该让程序起不来。
fn window_ratio() -> f64 {
    std::env::var("POSTMAX_WINDOW_SCALE")
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|ratio| (0.4..=1.0).contains(ratio))
        .unwrap_or(DEFAULT_RATIO)
}

/// 当前屏幕的工作区，换算成逻辑像素。
///
/// 必须换算。`Monitor::work_area()` 给的是物理像素，而窗口尺寸接口收的是逻辑像素：
/// 同一个 1440×900 在 125% 缩放下折算成 1800×1125，比 1080 的屏幕还高 ——
/// 窗口顶着屏幕外、底边压在任务栏底下，看着就像「分辨率不适配」。
fn work_area_logical(app: &AppHandle) -> (f64, f64) {
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| {
            let scale = if monitor.scale_factor() > 0.0 { monitor.scale_factor() } else { 1.0 };
            let area = monitor.work_area();
            (area.size.width as f64 / scale, area.size.height as f64 / scale)
        })
        // 拿不到显示器信息时按 1080p 估，总比不裁好
        .unwrap_or((1920.0, 1040.0))
}

/// 算初始尺寸（逻辑像素），返回 (客户区尺寸, 可拖拽的最小尺寸)。
///
/// `desired` 传 `None` 表示按屏幕比例算（主窗口）；传具体值表示固定尺寸（报错页）。
fn fit_to_screen(app: &AppHandle, desired: Option<(f64, f64)>) -> ((f64, f64), (f64, f64)) {
    let (avail_w, avail_h) = work_area_logical(app);
    let wanted = desired.unwrap_or_else(|| {
        let ratio = window_ratio();
        (avail_w * ratio, avail_h * ratio)
    });

    // 三个约束依次生效：夹到合理区间 → 不许超出可用区域 → 留出边距
    let width = wanted.0.clamp(INIT_MIN.0, MAX_SIZE.0).min(avail_w - EDGE * 2.0).max(1.0).floor();
    let height = wanted.1.clamp(INIT_MIN.1, MAX_SIZE.1).min(avail_h - EDGE).max(1.0).floor();

    // 拖拽下限不能超过初始尺寸，否则 tao 会反过来把窗口撑大：
    // 1366×768 开 125% 时可用高度只有 582，min 却在要 560 以上，窗口必然溢出屏幕。
    let min_w = DRAG_MIN.0.min(width);
    let min_h = DRAG_MIN.1.min(height);

    log(&format!(
        "[window] 可用 {avail_w:.0}×{avail_h:.0}（逻辑），初始 {width:.0}×{height:.0}，可拖到 {min_w:.0}×{min_h:.0}"
    ));
    ((width, height), (min_w, min_h))
}

/// 建主窗口。label 固定为 "main"，和 capabilities 里声明的一致。
///
/// `desired` 传 `None` 表示按屏幕比例定初始尺寸（主窗口），传具体值表示固定尺寸（报错页）。
/// 设 `POSTMAX_DEVTOOLS=1` 会打开远程调试端口（9222）—— 窗口里只剩一张报错页时，
/// 用它连上去看 console 比盲猜快得多。默认不开。
fn open_window(app: &AppHandle, url: WebviewUrl, title: &str, desired: Option<(f64, f64)>) -> tauri::Result<WebviewWindow> {
    let ((width, height), (min_w, min_h)) = fit_to_screen(app, desired);

    let mut builder = WebviewWindowBuilder::new(app, "main", url)
        .title(title)
        .inner_size(width, height)
        .min_inner_size(min_w, min_h)
        // 先藏着建。窗口一创建就显示的话，Windows 会先把它摆在自己挑的位置
        // （左上角 / 层叠位置），随后我们 set_position 才算居中 —— 用户看到的就是
        // 「闪一下左上角，再跳到中间」。藏起来建完、摆好位置再 show，屏幕上第一次
        // 出现就已经在中间了，没有这一跳。
        .visible(false)
        // 初始尺寸就是这个窗口的「原样」：最大化后点还原，Windows 回的就是它
        .maximizable(true)
        .resizable(true);

    if std::env::var("POSTMAX_DEVTOOLS").is_ok() {
        // 这一项会顶掉 Tauri 的默认参数，所以把默认那几个也写回来
        builder = builder.additional_browser_args(
            "--remote-debugging-port=9222 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
        );
    }

    let window = builder.build()?;
    // 建完再按真实外框校准一次：`inner_size` 只管客户区，标题栏和边框是额外的，
    // 而 `.center()` 是按整块屏幕算的、不扣任务栏 —— 实测 1920×1080 开 125% 时
    // 窗口底边正好被任务栏压住 60 px。
    // 这一步仍然在窗口不可见时做，所以尺寸/位置的修正不会被看见。
    fit_and_place(&window);

    // 摆好了才露面。show 不带焦点，单独补一个 set_focus —— 否则用快捷方式启动时
    // 窗口出来了但键盘输入还留在别的程序上。
    window.show()?;
    let _ = window.set_focus();
    Ok(window)
}

/// 把窗口收进工作区（扣掉任务栏的那块）并居中。
///
/// 全程用物理像素算：外框减客户区就是标题栏 + 边框的厚度，缩放比例是多少都不影响，
/// 算完再摆位置，不用猜标题栏有多高。
fn fit_and_place(window: &WebviewWindow) {
    let monitor = match window.current_monitor() {
        Ok(Some(monitor)) => monitor,
        // 拿不到显示器信息就让系统自己居中了事，至少不会崩
        _ => {
            let _ = window.center();
            return;
        }
    };
    let area = *monitor.work_area();
    let scale = if monitor.scale_factor() > 0.0 { monitor.scale_factor() } else { 1.0 };

    let (inner, outer) = match (window.inner_size(), window.outer_size()) {
        (Ok(inner), Ok(outer)) => (inner, outer),
        _ => return,
    };
    let frame_w = outer.width.saturating_sub(inner.width);
    let frame_h = outer.height.saturating_sub(inner.height);

    // 留白按物理像素给，不随缩放变大变小
    let pad = (EDGE * scale / 2.0) as u32;
    let max_w = area.size.width.saturating_sub(frame_w + pad * 2);
    let max_h = area.size.height.saturating_sub(frame_h + pad);
    if inner.width > max_w || inner.height > max_h {
        let w = inner.width.min(max_w).max(320);
        let h = inner.height.min(max_h).max(240);
        log(&format!(
            "[window] 外框 {}×{} 超出工作区 {}×{}，收到 {w}×{h}",
            outer.width, outer.height, area.size.width, area.size.height
        ));
        let _ = window.set_size(tauri::PhysicalSize::new(w, h));
    }

    let outer = window.outer_size().unwrap_or(outer);
    let x = area.position.x + (area.size.width as i32 - outer.width as i32) / 2;
    let y = area.position.y + (area.size.height as i32 - outer.height as i32) / 2;
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    log(&format!(
        "[window] 外框 {}×{} 摆在 {},{}，工作区 {}×{}",
        outer.width, outer.height, x, y, area.size.width, area.size.height
    ));
}

/// 起不来时降级：加载内置页，把原因写上去。
///
/// 比弹一个系统对话框好：用户能选中复制，截图发出去也看得清。
fn open_error_window(app: &AppHandle, message: &str) {
    log(&format!("[error] {message}"));
    let text = serde_json::to_string(message).unwrap_or_else(|_| "\"启动失败\"".to_string());
    let script = format!("window.__postmaxError && window.__postmaxError({text});");

    let window = match open_window(app, WebviewUrl::App("index.html".into()), "PostMax · 启动失败", Some((980.0, 640.0))) {
        Ok(window) => window,
        Err(e) => {
            log(&format!("[error] 连错误窗口都建不起来：{e}"));
            return;
        }
    };
    let _ = window.eval(&script);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let port = free_port();
            log(&format!("[start] 端口 {port}"));

            let spawned = app
                .shell()
                .sidecar("postmax-backend")
                // 端口和「别开浏览器」都从这儿传：后端只管起服务，
                // 界面由外壳的窗口负责显示。
                // 再把自己的 pid 交出去：外壳被强杀 / 崩溃时没人 kill 它，
                // 后端靠这个 pid 自己收尸，不然会留个占着端口的孤儿。
                .and_then(|cmd| {
                    cmd.args([
                        "--port".to_string(),
                        port.to_string(),
                        "--no-browser".to_string(),
                        "--parent-pid".to_string(),
                        std::process::id().to_string(),
                    ])
                    .spawn()
                });

            let (mut rx, child) = match spawned {
                Ok(pair) => pair,
                Err(e) => {
                    open_error_window(&handle, &format!("后端进程启动失败：{e}"));
                    return Ok(());
                }
            };

            app.manage(Backend(Mutex::new(Some(child))));

            // 后端的输出得一直读走：管道写满会把它卡死在半路。
            // release 版没有控制台，读到的内容只在 debug 下有地方看。
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                            let text = String::from_utf8_lossy(&line);
                            println!("[backend] {}", text.trim_end());
                            log_backend(text.trim_end());
                        }
                        CommandEvent::Terminated(payload) => {
                            println!("[backend] 已退出：{payload:?}");
                            log_backend(&format!("[terminated] {payload:?}"));
                        }
                        _ => {}
                    }
                }
            });

            // 等后端就绪再开窗。这段时间没有界面，但通常只有一两秒
            // （单文件 exe 首次启动要解包一次 Python 运行时，慢一点）。
            std::thread::spawn(move || {
                if !wait_ready(port, Duration::from_secs(30)) {
                    log("[ready] 等后端超时");
                    open_error_window(
                        &handle,
                        "后端服务没能启动：30 秒内没等到端口响应。\n\n\
                         常见原因：\n\
                         · 杀毒软件 / 企业安全策略拦下了 postmax-backend.exe\n\
                         · 没装 WebView2 运行时（便携版不会自动装，用安装包或自己装）\n\
                         · 上一轮的进程没退干净（任务管理器里结束 PostMax 后重开）\n\n\
                         排查：看 shell.log / backend.log（便携版在程序目录，安装版在 %APPDATA%\\PostMax），\
                         或直接双击 postmax-backend.exe 看报错。",
                    );
                    return;
                }

                log("[ready] 后端已监听，开窗");
                let url = match format!("http://127.0.0.1:{port}/index.html").parse() {
                    Ok(url) => url,
                    Err(e) => {
                        open_error_window(&handle, &format!("界面地址不合法：{e}"));
                        return;
                    }
                };
                if let Err(e) = open_window(&handle, WebviewUrl::External(url), "PostMax · API 测试工具", None) {
                    open_error_window(&handle, &format!("窗口创建失败：{e}"));
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 应用初始化失败")
        .run(|app_handle, event| {
            // 窗口关掉 → 顺手把后端子进程带走，别留孤儿进程
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<Backend>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.take() {
                            let _ = child.kill();
                            log("[exit] 后端已结束");
                        }
                    }
                }
            }
        });
}
