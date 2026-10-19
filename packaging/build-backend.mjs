/**
 * 把 Python 后端打成单个 exe，放到 Tauri 认的 sidecar 位置。
 *
 * 为什么要这一步：界面是网页，但「转发请求 / 掐断上游连接 / 读写存档」全在 Python 里。
 * Tauri 的外壳只负责开窗口，后端得作为子进程跟着走 —— 所以先出一个自带解释器的
 * exe，Tauri 打包时把它塞进安装目录，用户机器上就不用装 Python。
 *
 * 产物：src-tauri/binaries/postmax-backend-<target-triple>.exe
 *      （Tauri 的 externalBin 要求文件名带目标三元组，装完会自动去掉后缀）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

/** 目标三元组：目前只往 Windows x64 打，别的平台得换成对应值 */
const TARGET = process.env.POSTMAX_TARGET || 'x86_64-pc-windows-msvc';
const suffix = process.platform === 'win32' ? '.exe' : '';

/** 找 Python：显式指定 > 项目内 venv > PATH 上的 python */
function findPython() {
  const candidates = [
    process.env.POSTMAX_PYTHON,
    path.join(here, '.venv', 'Scripts', 'python.exe'),
    path.join(here, '.venv', 'bin', 'python'),
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

const python = findPython();
const workpath = path.join(here, '.build');
const distpath = path.join(workpath, 'dist');
const binaries = path.join(here, 'src-tauri', 'binaries');

console.log(`[backend] python: ${python}`);

// --onefile：Tauri 只搬一个文件，省得连一串依赖目录一起管
// --windowed：不带黑框控制台；没控制台时 stdout 是 None，run.py 里已改成写日志文件
const args = [
  '-m', 'PyInstaller',
  '--noconfirm', '--clean',
  '--onefile',
  '--windowed',
  '--name', 'postmax-backend',
  // 前端静态文件是后端发出去的，必须一起打进去。
  // 源路径必须写绝对路径：--specpath 换了目录，相对路径会按 spec 所在目录解析。
  '--add-data', `${path.join(repo, 'frontend')}${path.delimiter}frontend`,
  '--distpath', distpath,
  '--workpath', path.join(workpath, 'build'),
  '--specpath', workpath,
  path.join(repo, 'run.py'),
];

try {
  execFileSync(python, args, { cwd: repo, stdio: 'inherit' });
} catch (e) {
  console.error('\n[backend] PyInstaller 跑不起来。先建 venv 装依赖：');
  console.error(`  ${python} -m venv packaging/.venv`);
  console.error('  packaging/.venv/Scripts/pip install -r requirements.txt pyinstaller');
  process.exit(e.status || 1);
}

fs.mkdirSync(binaries, { recursive: true });
const produced = path.join(distpath, `postmax-backend${suffix}`);
const target = path.join(binaries, `postmax-backend-${TARGET}${suffix}`);
fs.copyFileSync(produced, target);
console.log(`[backend] -> ${target} (${(fs.statSync(target).size / 1048576).toFixed(1)} MB)`);
