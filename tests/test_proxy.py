"""响应读取策略的回归测试（标准库 unittest）。

跑：在仓库根目录 `python -m unittest tests.test_proxy`

盯的是三档限制：只保留前 N 字节、为了算大小继续读的上限、读取总时长；
以及 forward() 交给前端的字段是否够界面说清「为什么只看到一段」。
都不走网络：把 requests.Session.send 换成假的响应对象。
"""
from __future__ import annotations

import errno
import http.server
import json
import os
import socket
import threading
import time
import types
import unittest
from unittest import mock
from urllib.parse import urlparse

import requests

from backend import proxy


class FakeResponse:
    """够 proxy.forward / _read_body 用的最小响应对象。"""

    def __init__(self, chunks, status=200, delay=0.0):
        self.chunks = list(chunks)
        self.yielded = 0
        self.delay = delay
        self.status_code = status
        self.reason = 'OK'
        self.encoding = 'utf-8'
        self.headers = {'content-type': 'application/json; charset=utf-8'}
        self.raw = types.SimpleNamespace(headers={'content-type': 'application/json; charset=utf-8'})
        self.closed = False

    def iter_content(self, size=1):
        for chunk in self.chunks:
            if self.delay:
                import time

                time.sleep(self.delay)
            self.yielded += 1
            yield chunk

    def close(self):
        self.closed = True


class TestReadBodyLimits(unittest.TestCase):
    def test_small_body_is_kept_whole(self):
        resp = FakeResponse([b'hello', b' ', b'world'])
        with mock.patch.object(proxy, 'MAX_BODY_BYTES', 100):
            result = proxy._read_body(resp)
        self.assertEqual(result['body'], b'hello world')
        self.assertEqual(result['total'], 11)
        self.assertFalse(result['timedOut'])
        self.assertFalse(result['readCapped'])

    def test_keeps_only_the_limit_but_keeps_counting(self):
        resp = FakeResponse([b'aaaabbbb', b'ccccdddd'])
        with mock.patch.object(proxy, 'MAX_BODY_BYTES', 10):
            result = proxy._read_body(resp)
        self.assertEqual(result['body'], b'aaaabbbbcc', '只留前 10 字节')
        self.assertEqual(result['total'], 16, 'total 仍是真实大小')
        self.assertEqual(resp.yielded, 2, '为了算大小要继续读完')

    def test_read_cap_stops_reading(self):
        resp = FakeResponse([b'aaaaaaaaaa'] * 10)  # 一共 100 字节
        with mock.patch.object(proxy, 'MAX_BODY_BYTES', 4), mock.patch.object(
            proxy, 'MAX_READ_BYTES', 20
        ), mock.patch.object(proxy, 'READ_DEADLINE_SECONDS', 3600):
            result = proxy._read_body(resp)
        self.assertTrue(result['readCapped'])
        self.assertFalse(result['timedOut'])
        self.assertEqual(result['total'], 20)
        self.assertEqual(resp.yielded, 2, '到上限就不再读了')

    def test_deadline_stops_reading(self):
        resp = FakeResponse([b'x' * 8] * 5, delay=0.01)
        with mock.patch.object(proxy, 'MAX_BODY_BYTES', 1000), mock.patch.object(
            proxy, 'MAX_READ_BYTES', 10**9
        ), mock.patch.object(proxy, 'READ_DEADLINE_SECONDS', 0):
            result = proxy._read_body(resp)
        self.assertTrue(result['timedOut'])
        self.assertFalse(result['readCapped'])
        self.assertEqual(resp.yielded, 1, '到点立刻停，不再等下一个分块')

    def test_read_cap_wins_over_deadline(self):
        # 两个都超了：文件大是更可能的解释，先报「只统计到上限」
        resp = FakeResponse([b'x' * 10] * 5)
        with mock.patch.object(proxy, 'MAX_BODY_BYTES', 4), mock.patch.object(
            proxy, 'MAX_READ_BYTES', 10
        ), mock.patch.object(proxy, 'READ_DEADLINE_SECONDS', 0):
            result = proxy._read_body(resp)
        self.assertTrue(result['readCapped'])
        self.assertFalse(result['timedOut'])

    def test_empty_chunks_are_ignored(self):
        resp = FakeResponse([b'', b'abc', b'', b'de'])
        with mock.patch.object(proxy, 'MAX_BODY_BYTES', 100):
            result = proxy._read_body(resp)
        self.assertEqual(result['body'], b'abcde')
        self.assertEqual(result['total'], 5)


class TestForwardPayload(unittest.TestCase):
    def forward_with(self, resp, **patches):
        patches.setdefault('MAX_BODY_BYTES', 8)
        with mock.patch.multiple(proxy, **patches), mock.patch.object(
            proxy.requests.Session, 'send', lambda self, *a, **kw: resp
        ):
            return proxy.forward({'method': 'GET', 'url': 'http://example.com/x'})

    def test_payload_reports_limits(self):
        out = self.forward_with(FakeResponse([b'{"a":1}']))
        self.assertEqual(out['body'], '{"a":1}')
        self.assertEqual(out['size'], 7)
        self.assertFalse(out['truncated'])
        self.assertEqual(out['bodyLimit'], 8, '限制值随响应一起给前端，界面不用写死数字')
        self.assertEqual(out['readLimit'], proxy.MAX_READ_BYTES)
        self.assertEqual(out['readDeadline'], proxy.READ_DEADLINE_SECONDS)

    def test_truncated_flag_and_note_inputs(self):
        out = self.forward_with(FakeResponse([b'01234567', b'89abc']))
        self.assertEqual(out['body'], '01234567', '只保留前 8 字节')
        self.assertEqual(out['size'], 13)
        self.assertTrue(out['truncated'])
        self.assertFalse(out['readTimedOut'])
        self.assertFalse(out['readCapped'])

    def test_timeout_and_cap_flags_reach_the_frontend(self):
        out = self.forward_with(
            FakeResponse([b'x' * 10] * 5),
            MAX_READ_BYTES=10,
            READ_DEADLINE_SECONDS=3600,
        )
        self.assertTrue(out['readCapped'])
        self.assertFalse(out['readTimedOut'])

        out = self.forward_with(
            FakeResponse([b'x' * 10] * 5),
            MAX_READ_BYTES=10**9,
            READ_DEADLINE_SECONDS=0,
        )
        self.assertTrue(out['readTimedOut'])

    def test_response_is_closed_even_when_stopped_early(self):
        resp = FakeResponse([b'x' * 10] * 5)
        self.forward_with(resp, MAX_READ_BYTES=10, READ_DEADLINE_SECONDS=3600)
        self.assertTrue(resp.closed, '提前停下也要把连接关掉')


class TestConnectMessage(unittest.TestCase):
    """
    连不上的那句话必须是「哪台机器、为什么」。

    以前是直接贴 requests 的原文，用户看到的是
    「连不上服务器：HTTPConnectionPool(host='127.0.0.1', port=59999):
    Max retries exceeded with url: /nope」—— 库的类名和内部结构。而这句话会原样
    进自动化报告和失败摘要，被反复读。
    """

    @staticmethod
    def _conn_error(cause):
        error = requests.exceptions.ConnectionError(
            'HTTPConnectionPool(host="h", port=1): Max retries exceeded'
        )
        error.__cause__ = cause
        return error

    def test_refused(self):
        text = proxy._connect_hint(
            self._conn_error(OSError(errno.ECONNREFUSED, 'boom')),
            urlparse('http://127.0.0.1:59999/x'),
        )
        self.assertIn('127.0.0.1:59999', text)
        self.assertIn('拒绝连接', text)
        self.assertNotIn('HTTPConnectionPool', text, '不能把库的内部结构漏给用户')

    def test_dns(self):
        text = proxy._connect_hint(
            self._conn_error(socket.gaierror(11001, 'getaddrinfo failed')),
            urlparse('http://no-such-host.invalid/a'),
        )
        self.assertIn('域名解析不了', text)
        self.assertIn('no-such-host.invalid', text)

    def test_timeout(self):
        text = proxy._connect_hint(
            self._conn_error(OSError(errno.ETIMEDOUT, 'boom')),
            urlparse('http://a.b/c'),
        )
        self.assertIn('连接超时', text)

    def test_falls_back_to_text(self):
        # 异常链里认不出原因时退回文本判断，也仍然不能露内部结构
        text = proxy._connect_hint(
            self._conn_error(RuntimeError('Connection refused')),
            urlparse('http://a.b/c'),
        )
        self.assertIn('拒绝连接', text)
        self.assertIn('a.b', text)

    def test_no_port(self):
        text = proxy._connect_hint(
            self._conn_error(OSError(errno.ECONNREFUSED, 'boom')),
            urlparse('http://only-host/x'),
        )
        self.assertIn('only-host', text)


class TestProxyAwareMessage(unittest.TestCase):
    """
    走了代理时，那句「连不上」必须点名代理。

    实测踩过：服务进程从环境里继承了 HTTP_PROXY（指向一个不通的代理），
    每次转发都失败，界面上写着「连不上 127.0.0.1:59721：对方拒绝连接（服务
    没起来，或者端口不对）」—— 而那个服务恰恰是好的（请求就是从它自己那儿发
    出来的）。「对方」到底是代理还是目标，用户分不出来，这一句话会直接决定他
    接下来去查什么，所以必须说清楚。
    """

    @staticmethod
    def _conn_error(cause=None):
        error = requests.exceptions.ConnectionError('Max retries exceeded')
        if cause is not None:
            error.__cause__ = cause
        return error

    def test_proxy_is_named(self):
        text = proxy._connect_hint(
            self._conn_error(OSError(errno.ECONNREFUSED, 'boom')),
            urlparse('http://127.0.0.1:59721/api/health'),
            'http://127.0.0.1:54655',
        )
        self.assertIn('http://127.0.0.1:54655', text, '得说出是哪个代理')
        self.assertIn('HTTP_PROXY', text, '得说明这个代理是从哪儿来的')
        self.assertIn('127.0.0.1:59721', text, '目标地址还是要在')

    def test_proxy_blames_the_proxy_not_the_target(self):
        text = proxy._connect_hint(
            self._conn_error(OSError(errno.ECONNREFUSED, 'boom')),
            urlparse('http://a.b/c'),
            'http://p:1',
        )
        self.assertIn('代理拒绝了连接', text)
        self.assertNotIn('服务没起来', text, '有代理时不能把锅扣在被测服务上')

    def test_proxy_dns_and_timeout_reasons(self):
        dns = proxy._connect_hint(
            self._conn_error(socket.gaierror(11001, 'getaddrinfo failed')),
            urlparse('http://a.b/c'), 'http://p:1')
        self.assertIn('域名解析不了', dns)
        timeout = proxy._connect_hint(
            self._conn_error(OSError(errno.ETIMEDOUT, 'boom')),
            urlparse('http://a.b/c'), 'http://p:1')
        self.assertIn('连代理超时', timeout)

    def test_without_proxy_the_wording_is_unchanged(self):
        text = proxy._connect_hint(
            self._conn_error(OSError(errno.ECONNREFUSED, 'boom')),
            urlparse('http://a.b/c'),
        )
        self.assertIn('对方拒绝连接', text)
        self.assertNotIn('代理', text, '没走代理就别提代理，免得误导')

    def test_effective_proxy_prefers_https(self):
        with mock.patch.object(requests.utils, 'get_environ_proxies',
                               return_value={'http': 'http://h:1', 'https': 'http://s:2'}):
            self.assertEqual(proxy._effective_proxy('https://a.b/c'), 'http://s:2')
        with mock.patch.object(requests.utils, 'get_environ_proxies',
                               return_value={'http': 'http://h:1'}):
            self.assertEqual(proxy._effective_proxy('http://a.b/c'), 'http://h:1')
        with mock.patch.object(requests.utils, 'get_environ_proxies', return_value={}):
            self.assertEqual(proxy._effective_proxy('http://a.b/c'), '')

    def test_effective_proxy_never_raises(self):
        # 取代理只是为了让报错更好读，不能因为它本身出错就把请求带崩
        with mock.patch.object(requests.utils, 'get_environ_proxies',
                               side_effect=RuntimeError('boom')):
            self.assertEqual(proxy._effective_proxy('http://a.b/c'), '')

    def test_effective_proxy_reads_the_real_environment(self):
        # 用桩测不出「它到底认不认环境变量」—— 而这正是它存在的理由，真读一次
        clean = {k: v for k, v in os.environ.items()
                 if k.lower() not in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')}
        with mock.patch.dict(os.environ, clean, clear=True):
            os.environ['HTTP_PROXY'] = 'http://env-proxy:9'
            self.assertEqual(proxy._effective_proxy('http://a.b/c'), 'http://env-proxy:9')


class TestAbort(unittest.TestCase):
    """
    「终止」要真的把上游请求掐掉。

    前端 abort 掉的只是「浏览器 → 本地后端」这一跳。本地后端到被测服务的那一次
    请求原本会照跑完 —— 被测服务那边留着记录、副作用也照发生，只是结果没人要了。
    这一组盯的就是那一条连接有没有被真的断掉。
    """

    @staticmethod
    def _hang_server():
        """一个「收到请求就不吭声」的服务器，用来复现「在途请求」"""

        class Hang(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                time.sleep(5)
                try:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'ok')
                except Exception:
                    pass

            def log_message(self, *a):
                pass

        srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Hang)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return srv

    def test_kill_socket_wakes_the_blocked_read(self):
        """
        这一条钉住的是**为什么**要用 _real_close()。

        http.client 是拿着 socket.makefile('rb') 读的。makefile 会给 socket 的
        _io_refs 加一，于是 close() 只置一个标记、不真关 fd，阻塞中的读根本不醒；
        _real_close() 才是真的关，一关就醒。哪天有人觉得「用私有方法不好看」想换回
        close()，这里会红。
        """
        srv = self._hang_server()
        try:
            port = srv.server_address[1]
            sock = socket.create_connection(('127.0.0.1', port), timeout=10)
            sock.sendall(b'GET /hang HTTP/1.1\r\nHost: x\r\n\r\n')
            fp = sock.makefile('rb')
            state = {'woke': False}

            def reader():
                try:
                    fp.readline(100)
                except Exception:
                    state['woke'] = True

            t = threading.Thread(target=reader, daemon=True)
            t.start()
            time.sleep(0.4)

            t0 = time.time()
            proxy._kill_socket(sock)
            t.join(timeout=2)
            elapsed = time.time() - t0

            self.assertFalse(t.is_alive(), '关掉之后阻塞的读必须醒过来')
            self.assertTrue(state['woke'], '醒过来时应该抛异常，而不是拿到正常数据')
            self.assertLess(elapsed, 1.0, '要立刻醒，不是等它自己超时')
        finally:
            srv.shutdown()

    def test_client_gone_cuts_the_upstream_request(self):
        """客户端断开 → 立刻收工，并抛 ClientGone（不是等它自己超时）"""
        srv = self._hang_server()
        try:
            port = srv.server_address[1]
            state = {'gone': False}
            box = {}

            def go():
                try:
                    proxy.forward(
                        {'method': 'GET', 'url': f'http://127.0.0.1:{port}/hang'},
                        client_check=lambda: state['gone'],
                    )
                    box['ok'] = True
                except BaseException as e:  # noqa: BLE001
                    box['error'] = e

            t = threading.Thread(target=go, daemon=True)
            t0 = time.time()
            t.start()
            time.sleep(0.5)
            state['gone'] = True
            t.join(timeout=6)
            elapsed = time.time() - t0

            self.assertFalse(t.is_alive(), '客户端都走了，不该还挂着等上游')
            self.assertIsInstance(box.get('error'), proxy.ClientGone)
            self.assertLess(elapsed, 3, '掐断要快，不能等到超时（默认 30 秒）')
        finally:
            srv.shutdown()

    def test_no_client_check_runs_synchronously(self):
        """不给 client_check（单测、直接调用）就走同步老路，行为不变"""
        srv = self._hang_server()
        try:
            port = srv.server_address[1]
            box = {}

            def go():
                try:
                    out = proxy.forward({'method': 'GET', 'url': f'http://127.0.0.1:{port}/ok'})
                    box['status'] = out.get('status')
                except BaseException as e:  # noqa: BLE001
                    box['error'] = e

            t = threading.Thread(target=go, daemon=True)
            t.start()
            t.join(timeout=8)
            self.assertEqual(box.get('status'), 200)
        finally:
            srv.shutdown()


class TestChineseHeader(unittest.TestCase):
    """
    中文 header：**值**要能原样发出去；**名**要给清楚的说法，不能甩 500。

    名字这条路是死路，不是我们偷懒 —— HTTP 规范里 field-name 只能是 ASCII，
    Python 的 http.client 对名字硬编码 encode('ascii')。以前不做检查，
    一条 `中文名: 中文头的值` 就是后端 500，界面上只看到一句编码异常。
    """

    def test_chinese_value_round_trips(self):
        class Echo(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get('Content-Length') or 0)
                body = self.rfile.read(length)
                payload = json.dumps({
                    'headers': dict(self.headers.items()),
                    'body': body.decode('utf-8', 'replace'),
                })
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(payload.encode('utf-8'))

            def log_message(self, *a):
                pass

        srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Echo)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            port = srv.server_address[1]
            out = proxy.forward({
                'method': 'POST',
                'url': f'http://127.0.0.1:{port}/hdr',
                'headers': [{'key': 'X-Note', 'value': '中文头的值'}],
                'body': '{"a":1}',
            })
            self.assertEqual(out['status'], 200)
            # 看实际发出去的那份：值按 UTF-8 字节上线路，回显时还原成可读中文
            sent = {h['key']: h['value'] for h in out['request']['headers']}
            self.assertEqual(sent.get('X-Note'), '中文头的值')
            # 服务端收到的是 UTF-8 字节
            echoed = json.loads(out['body'])
            self.assertEqual(echoed['headers'].get('X-Note'), '中文头的值'.encode('utf-8').decode('latin-1'))
        finally:
            srv.shutdown()

    def test_chinese_name_gets_a_clear_error(self):
        with self.assertRaises(proxy.ProxyError) as cm:
            proxy.forward({
                'method': 'GET',
                'url': 'http://127.0.0.1:1/hdr',
                'headers': [{'key': '中文名', 'value': 'x'}],
            })
        self.assertIn('ASCII', str(cm.exception))
        self.assertNotIn('codec', str(cm.exception), '不能把编码异常原样甩给用户')


if __name__ == '__main__':
    unittest.main()
