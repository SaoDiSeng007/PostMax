# PostMax 打包（桌面版）
#
# 双击 打包.bat 就行，它只是转到这里；命令行也可以：
#   打包.bat all | installer | portable | check | clean [/np]
#
# 为什么逻辑放在 .ps1 而不是 .bat：
#   bat 里的中文只能存成 GBK，编辑器按 UTF-8 打开就是乱码；存成 UTF-8 又会让
#   cmd 按偏移读行时错位（半行被当成命令执行）。PowerShell 没这个毛病。
#
# 本文件是 UTF-8（带 BOM）：Windows PowerShell 5.1 读不带 BOM 的 UTF-8 会按
# ANSI 解码，中文全乱。用编辑器改的时候保持 UTF-8 with BOM。

$Here = $PSScriptRoot
$Root = Split-Path -Parent $Here
$Venv = Join-Path $Here '.venv'
$Py = Join-Path $Venv 'Scripts\python.exe'
$Release = Join-Path $Here 'src-tauri\target\release'
$Nsis = Join-Path $Release 'bundle\nsis'
$Dist = Join-Path $Here 'dist'

# 工具链不在 PATH 里时也能找到（装完没重开窗口的情况很常见）
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"

$script:Missing = $false
$script:ExitCode = 0

function Write-Missing($name, $use, $install, $url, $note) {
    $script:Missing = $true
    Write-Host "    [缺]  $name"
    Write-Host "          用途：$use"
    Write-Host "          安装：$install"
    Write-Host "          下载：$url"
    if ($note) { Write-Host "          注意：$note" }
    Write-Host ''
}

function Test-Checks {
    $script:Missing = $false

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node -and (Test-Path (Join-Path $env:ProgramFiles 'nodejs\node.exe'))) {
        $env:Path = (Join-Path $env:ProgramFiles 'nodejs') + ';' + $env:Path
        $node = Get-Command node -ErrorAction SilentlyContinue
    }
    if ($node) {
        Write-Host "    [ok]  Node.js $(& node --version)"
    } else {
        Write-Missing 'Node.js' '前端依赖和 Tauri CLI 都靠它' `
            'winget install OpenJS.NodeJS.LTS' 'https://nodejs.org/zh-cn/download'
    }

    if ($node) {
        if (Get-Command npm -ErrorAction SilentlyContinue) {
            Write-Host '    [ok]  npm 就绪'
        } else {
            Write-Missing 'npm' '装前端依赖用，正常跟 Node.js 一起装' `
                'winget install OpenJS.NodeJS.LTS' 'https://nodejs.org/zh-cn/download'
        }
    }

    $cargo = Get-Command cargo -ErrorAction SilentlyContinue
    if ($cargo) {
        Write-Host "    [ok]  $(& cargo --version)"
    } else {
        Write-Missing 'Rust' '编译桌面外壳，没它 tauri build 直接退出' `
            'winget install Rustlang.Rustup' 'https://rustup.rs/'
    }

    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vspath = ''
    if (Test-Path $vswhere) {
        $vspath = (& $vswhere -latest -products * `
                -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
                -property installationPath 2>$null | Select-Object -First 1)
    }
    if ($vspath) {
        Write-Host "    [ok]  MSVC  $vspath"
    } else {
        Write-Missing 'MSVC C++ 生成工具' 'Rust 最后要调 link.exe 链接，缺它报 linker not found' `
            'winget install Microsoft.VisualStudio.2022.BuildTools' `
            'https://visualstudio.microsoft.com/zh-hans/visual-cpp-build-tools/' `
            '装的时候勾上「使用 C++ 的桌面开发」，别只装个空壳'
    }

    if (Test-Path $Py) {
        Write-Host '    [ok]  Python 虚拟环境已就绪'
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        Write-Host "    [ok]  $(& python --version)"
    } elseif (Get-Command py -ErrorAction SilentlyContinue) {
        Write-Host '    [ok]  py 启动器可用，会自动建虚拟环境'
    } else {
        Write-Missing 'Python 3.10+' '后端要打成 exe，PyInstaller 靠它跑' `
            'winget install Python.Python.3.12' 'https://www.python.org/downloads/windows/'
    }

    $wv = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\EdgeWebView\Application'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\EdgeWebView\Application')
    ) | Where-Object { Test-Path $_ } | ForEach-Object {
        Get-ChildItem $_ -Directory -ErrorAction SilentlyContinue
    } | Select-Object -First 1
    if ($wv) {
        Write-Host "    [ok]  WebView2 $($wv.Name)"
    } else {
        Write-Missing 'WebView2 运行时' '打出来的程序靠它显示界面，Win10/11 一般自带' `
            'winget install Microsoft.EdgeWebView2Runtime' `
            'https://developer.microsoft.com/zh-cn/microsoft-edge/webview2/'
    }

    if (Test-Path (Join-Path $env:LOCALAPPDATA 'tauri\NSIS')) {
        Write-Host '    [ok]  NSIS 已缓存，断网也能打安装包'
    } else {
        Write-Host '    [..]  NSIS 还没缓存，第一次打包会自己下载约 30MB'
    }

    return (-not $script:Missing)
}

function Show-Products {
    # 每次都要现算，否则菜单来回切还会显示上一次的结果
    Write-Host '  当前产物：'
    $setup = Get-ChildItem $Nsis -Filter *.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($setup) { Write-Host "    [有] $($setup.Name)" } else { Write-Host '    [无] 安装包' }
    $zip = Get-ChildItem $Dist -Filter *.zip -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($zip) { Write-Host "    [有] $($zip.Name)" } else { Write-Host '    [无] 免安装包' }
}

function Show-Menu {
    Clear-Host
    Write-Host ''
    Write-Host '============================================================'
    Write-Host '  PostMax 打包'
    Write-Host "  项目：$Root"
    Write-Host '============================================================'
    Write-Host ''
    Write-Host '  1  全部           安装包 + 免安装包        （最常用）'
    Write-Host '  2  只出安装包     setup.exe，双击安装'
    Write-Host '  3  只出免安装包   免安装 zip，解压即用'
    Write-Host '  4  只体检         检查工具链，不打包'
    Write-Host '  5  清理           删中间产物，保留 cargo 缓存'
    Write-Host '  6  打开产物目录'
    Write-Host '  0  退出'
    Write-Host ''
    Show-Products
    Write-Host ''
}

function Fail($message) {
    $script:ExitCode = 1
    Write-Host ''
    Write-Host '============================================================'
    Write-Host '  打包没有完成，上面写了原因'
    Write-Host '============================================================'
    Write-Host ''
    Write-Host $message
    Write-Host ''
}

function Invoke-Clean {
    Clear-Host
    Write-Host ''
    Write-Host '============================================================'
    Write-Host '  清理'
    Write-Host '============================================================'
    Write-Host ''
    Write-Host '  会删掉：'
    Write-Host '    packaging\dist                      免安装包输出'
    Write-Host '    packaging\.build                    PyInstaller 中间产物'
    Write-Host '    packaging\src-tauri\binaries\*.exe  sidecar 副本'
    Write-Host ''
    Write-Host '  保留 src-tauri\target 里的 cargo 缓存（删了下次要全量重编）'
    Write-Host ''
    $answer = Read-Host '  确认清理？输入 y 确认，其它键回菜单'
    if ($answer -notmatch '^\s*[yY]\s*$') { return }

    Remove-Item $Dist -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $Here '.build') -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem (Join-Path $Here 'src-tauri\binaries') -Filter *.exe -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
    Write-Host ''
    Write-Host '  清理完成。'
}

function Invoke-Reveal {
    if (Test-Path $Nsis) {
        Start-Process explorer.exe $Nsis
    } elseif (Test-Path $Dist) {
        Start-Process explorer.exe $Dist
    } else {
        Write-Host ''
        Write-Host '  还没有产物，先打一次包。'
        Write-Host ''
    }
}

function Invoke-Pack($mode, $what) {
    $script:ExitCode = 0
    Clear-Host
    Write-Host ''
    Write-Host '============================================================'
    Write-Host '  PostMax 打包'
    Write-Host "  项目：$Root"
    Write-Host "  本次：$what"
    Write-Host '============================================================'
    Write-Host ''
    Write-Host '[1/4] 检查环境'
    Write-Host ''

    if (-not (Test-Checks)) {
        Write-Host '============================================================'
        Write-Host '  环境不齐，没开始打包'
        Write-Host '============================================================'
        Write-Host ''
        Write-Host '  上面每条 [缺] 都给了安装命令，复制到 PowerShell 里执行即可。'
        Write-Host '  winget 用不了的，用后面的下载地址手动装。'
        Write-Host ''
        Write-Host '  装完必须重开一个窗口再运行本脚本，否则 PATH 还是旧的。'
        Write-Host ''
        $script:ExitCode = 1
        return
    }
    if ($mode -eq 'check') {
        Write-Host '============================================================'
        Write-Host '  环境齐全，可以打包'
        Write-Host '============================================================'
        Write-Host ''
        Write-Host '  回菜单选 1，打安装包 + 免安装包。'
        Write-Host ''
        return
    }

    Write-Host '============================================================'
    Write-Host '  [2/4] 准备 Python 依赖'
    Write-Host '============================================================'
    Write-Host ''

    if (-not (Test-Path $Py)) {
        Write-Host '  [..] 创建虚拟环境'
        if (Get-Command python -ErrorAction SilentlyContinue) {
            & python -m venv $Venv | Out-Host
        } else {
            & py -3 -m venv $Venv | Out-Host
        }
        if (-not (Test-Path $Py)) {
            Fail "  [X] 虚拟环境建不起来（$Venv）"
            return
        }
    }

    & $Py -c 'import flask, requests, PyInstaller' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host '  [..] 安装后端依赖，第一次要一两分钟'
        & $Py -m pip install --quiet --upgrade pip | Out-Host
        & $Py -m pip install --quiet -r (Join-Path $Root 'requirements.txt') pyinstaller | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Host '  [X] 依赖装不上，多半是网络问题。换国内源重试：'
            Write-Host "      `"$Py`" -m pip install -r `"$(Join-Path $Root 'requirements.txt')`" pyinstaller -i https://pypi.tuna.tsinghua.edu.cn/simple"
            Fail '  [X] 后端依赖没装上'
            return
        }
    }

    Write-Host ''
    Write-Host '============================================================'
    Write-Host '  [3/4] 准备前端构建依赖'
    Write-Host '============================================================'
    Write-Host ''
    if (-not (Test-Path (Join-Path $Here 'node_modules\@tauri-apps\cli'))) {
        Write-Host '  [..] npm install'
        Push-Location $Here
        & npm install --no-audit --no-fund | Out-Host
        $rc = $LASTEXITCODE
        Pop-Location
        if ($rc -ne 0) {
            Write-Host '  [X] npm install 失败。换源重试：'
            Write-Host "      cd /d `"$Here`" && npm install --registry=https://registry.npmmirror.com"
            Fail '  [X] 前端构建依赖没装上'
            return
        }
    }

    Write-Host ''
    Write-Host '============================================================'
    Write-Host '  [4/4] 开始打包'
    Write-Host '============================================================'
    Write-Host ''
    Write-Host '  [..] 打后端 exe（PyInstaller，第一次一两分钟）'
    Push-Location $Here
    & node build-backend.mjs | Out-Host
    $rc = $LASTEXITCODE
    Pop-Location
    if ($rc -ne 0) {
        Fail '  [X] 后端 exe 没打出来，往上翻 PyInstaller 的报错'
        return
    }

    if ($mode -ne 'portable') {
        Write-Host '  [..] 编译 Tauri 外壳，第一次三到六分钟，之后一两分钟'
        Push-Location $Here
        & npx --no-install tauri build | Out-Host
        $rc = $LASTEXITCODE
        Pop-Location
        if ($rc -ne 0) {
            Fail '  [X] 外壳编译失败。link.exe 找不到就回第 1 步查 MSVC'
            return
        }
    } elseif (-not (Test-Path (Join-Path $Release 'postmax.exe'))) {
        Fail '  [X] 还没有 postmax.exe，先完整打一次包（选 1）'
        return
    }

    if ($mode -ne 'installer') {
        Write-Host '  [..] 组装免安装版'
        Push-Location $Here
        & node make-portable.mjs | Out-Host
        $rc = $LASTEXITCODE
        Pop-Location
        if ($rc -ne 0) {
            Fail '  [X] 免安装版没组装出来，往上翻 make-portable 的报错'
            return
        }
    }

    $script:ExitCode = 0
    Write-Host ''
    Write-Host '============================================================'
    Write-Host '  打包完成'
    Write-Host '============================================================'
    if ($mode -ne 'portable') {
        Write-Host "  安装包：$Nsis\"
        Get-ChildItem $Nsis -Filter *.exe -ErrorAction SilentlyContinue |
            ForEach-Object { Write-Host "    $($_.Name)" }
    }
    if ($mode -ne 'installer') {
        Write-Host "  免安装：$Dist\"
        Get-ChildItem $Dist -Filter *.zip -ErrorAction SilentlyContinue |
            ForEach-Object { Write-Host "    $($_.Name)" }
    }
    Write-Host ''
}

# ------------------------------------------------------------ 入口

if (-not (Test-Path (Join-Path $Root 'run.py'))) {
    Write-Host ''
    Write-Host '  [X] 认不出项目目录：上一级里没有 run.py'
    Write-Host '      这个 packaging 文件夹要整个放在 postmax 项目根目录下，'
    Write-Host '      和 backend\ / frontend\ 平级。'
    Write-Host ''
    exit 1
}

$mode = ''
$noPause = $false
foreach ($arg in $args) {
    if ($arg -ieq '/np') { $noPause = $true }
    elseif (-not $mode) { $mode = $arg }
}

# 带参数直接干活，不带参数进菜单
if ($mode) {
    $modes = @{
        'all'       = @('all', '安装包 + 免安装包')
        '1'         = @('all', '安装包 + 免安装包')
        'installer' = @('installer', '只出安装包（setup.exe）')
        '2'         = @('installer', '只出安装包（setup.exe）')
        'portable'  = @('portable', '只出免安装包（复用上次编好的 exe）')
        '3'         = @('portable', '只出免安装包（复用上次编好的 exe）')
        'check'     = @('check', '只体检，不打包')
        '4'         = @('check', '只体检，不打包')
        'clean'     = @('clean', '清理')
        '5'         = @('clean', '清理')
        'reveal'    = @('reveal', '打开产物目录')
        '6'         = @('reveal', '打开产物目录')
    }
    $key = $mode.ToLower()
    if ($key -eq '0' -or $key -eq 'q') { exit 0 }
    if ($modes.ContainsKey($key)) {
        $target, $what = $modes[$key]
        switch ($target) {
            'clean' { Invoke-Clean }
            'reveal' { Invoke-Reveal }
            default { Invoke-Pack $target $what }
        }
        if (-not $noPause) {
            Write-Host '按任意键关闭窗口。'
            [void](Read-Host)
        }
        exit $script:ExitCode
    }
    Write-Host ''
    Write-Host "  [X] 没有 $mode 这个序号，只能是 0 到 6"
    Write-Host ''
    exit 1
}

$empty = 0
while ($true) {
    Show-Menu
    $answer = Read-Host '  请输入序号（0-6），回车确认'
    $answer = ("$answer").Trim()
    if (-not $answer) {
        $empty++
        if ($empty -ge 3) { exit 0 }
        Write-Host ''
        Write-Host '    没有输入任何内容，请按 0-6 的数字再回车。'
        continue
    }
    $empty = 0

    switch ($answer.ToLower()) {
        '0' { exit 0 }
        'q' { exit 0 }
        '1' { Invoke-Pack 'all' '安装包 + 免安装包' }
        '2' { Invoke-Pack 'installer' '只出安装包（setup.exe）' }
        '3' { Invoke-Pack 'portable' '只出免安装包（复用上次编好的 exe）' }
        '4' { Invoke-Pack 'check' '只体检，不打包' }
        '5' { Invoke-Clean }
        '6' { Invoke-Reveal }
        default {
            Write-Host ''
            Write-Host "  [X] 没有 $answer 这个序号，只能是 0 到 6"
        }
    }
    Write-Host '按任意键回菜单。'
    [void](Read-Host)
}
