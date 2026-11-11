"""Read-only API and fixed-path release files, behind the existing reverse proxy."""
import json
import os
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from core import Store, WINDOWS

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get('SBHOT_DATA', '/var/lib/sbhot'))
HTML = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>烧饼热榜</title><style>body{max-width:760px;margin:8vh auto;padding:24px;font:16px/1.8 system-ui;color:#222}a{color:#795700}pre{white-space:pre-wrap;background:#f5f5f5;padding:16px;border-radius:12px}</style>
<h1>烧饼热榜</h1><p>实时 · 24小时 · 周榜 · 30天榜</p>
<p><a href="/shaobing-hot.user.js">安装 / 更新脚本</a> · <a href="https://github.com/mozisen/SBHOT">源码与使用说明</a> · <a href="/api/status">采集状态</a></p>
<p>24小时与30天榜优先使用官方榜单，每15分钟同步并共享缓存，统计口径以官方说明为准。实时（近1小时）和周榜共用后台快照统计，每5分钟扫描活跃主题、每小时遍历公开列表，仅保留9天增量。快照计数不能还原精确访问时间；周榜在积累满7天前会明确标注。</p>
<p>首次安装后，在 Tampermonkey 中开启自动安装。脚本每小时检查版本，实际安装由管理器调度。</p>
<pre id="status">正在获取采集状态…</pre><script>fetch('/api/status').then(r=>r.json()).then(s=>{document.getElementById('status').textContent='已发现公开主题：'+s.topics+'\\n'+(s.baseline_complete?'基线已完成，统计持续积累中':'正在建立全站基线')+'\\n最近观察：'+(s.last_observation?new Date(s.last_observation*1000).toLocaleString():'尚未开始')+(s.stale?'\\n完整扫描尚未完成或已过期':'');}).catch(()=>{document.getElementById('status').textContent='暂时无法读取状态';});</script></html>'''


class Handler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.do_GET()

    def send(self, code, body, kind='application/json; charset=utf-8', cache='no-store'):
        raw = body if isinstance(body, bytes) else body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', cache)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Access-Control-Allow-Origin', 'https://sb.sb')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(raw)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ('/shaobing-hot.user.js', '/shaobing-hot.meta.js',
                    '/shaobing-reply-reminder.user.js', '/shaobing-reply-reminder.meta.js'):
            file = ROOT / path[1:]
            if not file.is_file():
                self.send(503, '{"error":"release_unavailable"}')
            else:
                self.send(200, file.read_bytes(), 'application/javascript; charset=utf-8', 'no-cache')
            return
        if path == '/':
            self.send(200, HTML, 'text/html; charset=utf-8')
            return
        if path == '/robots.txt':
            self.send(200, 'User-agent: *\nDisallow: /api/\n', 'text/plain')
            return
        period = path.removeprefix('/api/rankings/')
        if path not in ('/healthz', '/api/status') and (not path.startswith('/api/rankings/') or period not in WINDOWS):
            self.send(404, '{"error":"not_found"}')
            return
        store = None
        try:
            # Initialized by collector/deployment; read-only API never creates or migrates a DB.
            store = Store.__new__(Store)
            store.db = sqlite3.connect(f'file:{DATA / "stats.sqlite3"}?mode=ro', uri=True, timeout=5)
            store.db.row_factory = sqlite3.Row
            now = int(time.time())
            if path == '/healthz':
                status = store.status(now)
                value = {'ok': True, 'ready': status['baseline_complete'], 'stale': status['stale']}
            elif path == '/api/status':
                value = store.status(now)
            else:
                value = store.ranking(period, now)
            self.send(200, json.dumps(value, ensure_ascii=False), cache='public, max-age=30' if period in WINDOWS else 'no-store')
        except (sqlite3.Error, ValueError):
            self.send(503, '{"error":"data_unavailable"}')
        finally:
            if store and getattr(store, 'db', None):
                store.db.close()


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('PORT', '16611'))), Handler).serve_forever()
