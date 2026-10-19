#!/usr/bin/env node
/**
 * 组装免安装（便携）版。
 *
 * 只是「拷贝 + 放一个标记文件 + 压包」，不改任何二进制 —— 便携和安装版用的是
 * 同一份 postmax.exe，靠 exe 旁边的 portable.flag 区分数据存哪（见 backend/storage.py）。
 *
 * 用法：npm run build 之后跑 `node make-portable.mjs`
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const release = path.join(here, 'src-tauri', 'target', 'release');
const version = JSON.parse(fs.readFileSync(path.join(here, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
const name = `PostMax-${version}-portable`;
const outDir = path.join(here, 'dist', name);
const outZip = path.join(here, 'dist', `${name}.zip`);

const shell = path.join(release, 'postmax.exe');
// sidecar 在 release 根目录叫 postmax-backend.exe（Tauri 去掉 target triple 后放这儿）
const backend = path.join(release, 'postmax-backend.exe');

for (const file of [shell, backend]) {
  if (!fs.existsSync(file)) {
    console.error(`缺文件：${file}\n先跑 npm run build。`);
    process.exit(1);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(shell, path.join(outDir, 'postmax.exe'));
fs.copyFileSync(backend, path.join(outDir, 'postmax-backend.exe'));

// 空存档目录先建好，用户第一次打开就有地方写，也让人一眼看出数据在哪
fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });

fs.writeFileSync(
  path.join(outDir, 'portable.flag'),
  '\ufeff' +
  '这个文件在，PostMax 就把存档写在本目录的 data\\ 下（便携模式）。\n' +
    '删掉它就是安装版的默认行为：存到 %APPDATA%\\PostMax。\n',
  'utf8',
);

fs.writeFileSync(
  path.join(outDir, '使用说明.txt'),
  '\ufeff' +
  `PostMax 便携版 ${version}
${'='.repeat(18)}

免安装：解压到任意可写目录（U 盘也行），双击 postmax.exe 即可。

必须知道的：
· postmax.exe 和 postmax-backend.exe 必须放在同一目录，不能只拷其中一个。
· postmax.exe 可以改名，postmax-backend.exe 不能改名。
· 目录里的 portable.flag 决定数据存哪：
    有它 → 存档 / 备份 / 日志都写在本目录的 data\\ 下，整个文件夹拷走就带走一切；
    删它 → 退回安装版行为，写到 %APPDATA%\\PostMax。
· 前提是这台机器有 WebView2 运行时。Win11 和 Win10 1803+ 通常自带；
  没有的话窗口会提示"后端服务没能启动"，去微软官网下载
  "Microsoft Edge WebView2 Runtime" 装上再打开。

不要和安装版同时开：两边都指向同一份 data.json 时，后保存的会盖掉先保存的。

窗口大小：
· 默认按屏幕可用区域（扣掉任务栏）的 0.75 开；
· 点最大化铺满，点还原回到这个初始尺寸；
· 想改默认大小，在本目录建一个 启动.bat 写：
     set POSTMAX_WINDOW_SCALE=0.65
     start "" postmax.exe
  数字范围 0.4 ~ 1.0，越小窗口越小。

排错：目录下的两个日志
· shell.log    外壳的启动记录（窗口报错时先看这个）
· backend.log  后端的输出（端口、Flask 访问日志、崩溃信息）
`,
  'utf8',
);

// 用系统自带的压缩，别为这一件事再拉个依赖
fs.rmSync(outZip, { force: true });
execFileSync(
  'powershell',
  ['-NoProfile', '-Command', `Compress-Archive -Path '${outDir}\\*' -DestinationPath '${outZip}' -Force`],
  { stdio: 'inherit' },
);

const mb = (p) => (fs.statSync(p).size / 1024 / 1024).toFixed(1);
console.log(`\n[portable] dir : ${outDir}`);
console.log(`[portable] zip : ${outZip} (${mb(outZip)} MB)`);
