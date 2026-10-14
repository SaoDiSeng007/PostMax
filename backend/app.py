"""PostMax 后端应用。

一个进程同时干三件事：转发请求、读写数据文件、把前端静态文件发出去。
因为前后端同源，前端直接 fetch('/api/...') 就行，不用处理跨域。
"""
from __future__ import annotations

import os
import select
import socket
import sys

from flask import Flask, jsonify, request, send_from_directory

from . import proxy, storage


def frontend_dir() -> str:
    """前端目录。

    打包后它在 PyInstaller 的临时解包目录里（只读），
    所以这里和生产数据的目录是两回事，别混用。
    """
    if getattr(sys, 'frozen', False):
        root = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(sys.executable)))
    else:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(root, 'frontend')


def client_gone() -> bool:
    """浏览器是不是已经断开了这次请求 —— 用户点「终止」时就是这个样子。

    werkzeug 的服务器会把客户端 socket 放进 environ（`werkzeug.socket`）。请求体
    早就读完了，这时候它还可读，只可能是对端把连接关了；用 MSG_PEEK 看一眼即可，
    数据不会被取走，也不会影响后面的响应。

    拿不到 socket（换成别的 WSGI 服务器了）就一律当成「还在」，行为退回改动之前：
    终止仍能停住前端的等待，只是后端不会去掐上游那一条连接。
    """
    sock = request.environ.get('werkzeug.socket')
    if sock is None:
        return False
    try:
        readable, _, _ = select.select([sock], [], [], 0)
        if not readable:
            return False
        return sock.recv(1, socket.MSG_PEEK) == b''
    except (OSError, ValueError):
        return True


def create_app() -> Flask:
    app = Flask(__name__, static_folder=None)

    @app.after_request
    def disable_cache(resp):
        """静态文件禁用缓存。

        前端是无构建的，改完代码直接 F5 —— 没有构建步骤帮你换文件名打断缓存，
        那就只能靠禁缓存，否则改了没生效还得怀疑人生。
        接口响应不做这个处理。
        """
        if not request.path.startswith('/api/'):
            resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
            resp.headers['Pragma'] = 'no-cache'
            resp.headers['Expires'] = '0'
        return resp

    @app.get('/api/health')
    def health():
        return jsonify({'ok': True, 'dataFile': storage.data_file()})

    @app.get('/api/state')
    def get_state():
        try:
            return jsonify(storage.load())
        except Exception as e:
            app.logger.exception('读取数据失败')
            return jsonify({'error': f'读取数据失败：{e}'}), 500

    @app.put('/api/state')
    def put_state():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({'error': '请求体必须是 JSON 对象'}), 400
        try:
            result = storage.save(payload)
        except Exception as e:
            # 落盘失败意味着这次改动丢了，更得把真实原因说清楚，
            # 而不是让 Flask 回一张前端解析不了的 HTML 500
            app.logger.exception('写入数据失败')
            return jsonify({'error': f'写入数据失败：{e}'}), 500

        if result is None:
            # 盘上的 revision 比这次提交的基线新 —— 另一个实例改过。
            # 这里不写，让前端决定「载入磁盘」还是「用我的覆盖」（带 force 重发）
            return jsonify({'error': '这份数据被另一个窗口改过', 'conflict': True}), 409

        return jsonify(result)

    @app.post('/api/proxy')
    def do_proxy():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({'error': '请求体必须是 JSON 对象'}), 400
        try:
            return jsonify(proxy.forward(payload, client_check=client_gone))
        except proxy.ClientGone:
            # 客户端自己走了（多半是点了「终止」）。上游连接已经掐掉，这一轮到此为止；
            # 响应没人在等，回什么都不重要，但别让它落进下面那个兜底 500 里报成「工具出错」
            return jsonify({'error': '客户端已断开，本次请求已终止'}), 499
        except proxy.ProxyError as e:
            # 502：是上游请求失败，不是这个服务本身出错
            return jsonify({'error': str(e)}), 502
        except Exception as e:
            # 兜底：任何没预料到的异常也回 JSON。
            # 否则 Flask 默认返回一张 HTML 错误页，前端拿去 JSON.parse 会报出
            # 一个和真实原因毫无关系的错，白白浪费排查时间。
            app.logger.exception('转发时出现未预期的错误')
            return jsonify({'error': f'后端处理出错：{e}'}), 500

    @app.get('/')
    def index():
        return send_from_directory(frontend_dir(), 'index.html')

    @app.get('/<path:filename>')
    def assets(filename):
        # 上面没有匹配到的 /api/xxx 明确回 404，不去静态目录里瞎找 —— 
        # 否则一个拼错的接口会返回 HTML，前端解析 json 时报的错会非常难懂
        if filename == 'api' or filename.startswith('api/'):
            return jsonify({'error': f'没有这个接口：/{filename}'}), 404
        return send_from_directory(frontend_dir(), filename)

    return app
