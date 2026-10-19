"""PostMax 启动入口。

开发时 `python run.py`；打包成 exe 之后双击即可 ——
会自动挑一个空闲端口、打开浏览器，然后把界面地址和数据文件位置打在控制台上。
"""
from __future__ import annotations

import os
import socket
import threading
import webbrowser

from backend import storage
from backend.app import create_app

PORT_START = 59721
PORT_TRIES = 10


def pick_port() -> int:
    """从 59721 往后找一个没被占用的端口。

    固定端口看着简单，但同一台机器上开了第二个实例就起不来了，
    而「再开一个」恰恰是调试后端时最常干的事。
    """
    for port in range(PORT_START, PORT_START + PORT_TRIES):
        with socket.socket() as sock:
            try:
                sock.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue
    raise SystemExit(
        f'{PORT_START} ~ {PORT_START + PORT_TRIES - 1} 这些端口都被占用了，先关掉其他实例再启动。'
    )


def main() -> None:
    port = pick_port()
    url = f'http://127.0.0.1:{port}/index.html'

    # 等服务器真正起来再开浏览器，否则会撞上「无法访问此网站」。
    # 自动化测试时设 POSTMAX_NO_BROWSER=1 可以跳过这一步。
    if not os.environ.get('POSTMAX_NO_BROWSER'):
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    print('PostMax 已启动')
    print(f'  界面  {url}')
    print(f'  数据  {storage.data_file()}')
    print('  按 Ctrl+C 停止\n')

    create_app().run(
        host='127.0.0.1',
        port=port,
        debug=False,
        threaded=True,
        use_reloader=False,
    )


if __name__ == '__main__':
    main()
