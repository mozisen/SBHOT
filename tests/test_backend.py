import importlib.util
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from core import Store, parse_page, parse_official, WINDOWS
import server

FIXTURE = (Path(__file__).parent / 'fixtures/topics.html').read_text(encoding='utf-8')


class BackendTests(unittest.TestCase):
    def setUp(self):
        artifacts = Path(__file__).resolve().parents[1] / 'artifacts'
        artifacts.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=artifacts)
        self.path = Path(self.temp.name) / 'stats.sqlite3'
        self.store = Store(self.path)
        self.now = 1800000000

    def tearDown(self):
        self.store.db.close()
        self.temp.cleanup()

    def post(self, **changes):
        return dict(dict(id=1, title='<safe>', author='a', forum='f', views=100, replies=10,
                         published=self.now - 86400, activity=self.now, pinned=False), **changes)

    def test_real_parser_pagination(self):
        posts, nxt = parse_page(FIXTURE, '/new/')
        self.assertEqual(len(posts), 3)
        self.assertEqual(nxt, '/new/page/2/')
        self.assertEqual(posts[0]['id'], 7121)
        self.assertEqual(posts[0]['views'], 1722)
        self.assertEqual(posts[0]['replies'], 31)
        self.assertTrue(posts[0]['pinned'])

    def test_reject_bad_pages_and_external_pagination(self):
        for html in ['<h1>Login</h1>', FIXTURE.replace('/new/page/2/', 'https://evil.test/new/page/2/')]:
            with self.assertRaises(ValueError):
                parse_page(html, '/new/')

    def test_baseline_is_not_historical_activity_and_dedup(self):
        self.store.ingest([self.post()], self.now)
        self.store.complete_full(self.now, self.now + 1)
        self.assertEqual(self.store.ranking('weekly', self.now + 2)['boards']['views'], [])
        self.store.ingest([self.post(views=110, replies=12)], self.now + 300)
        self.store.ingest([self.post(views=110, replies=12)], self.now + 301)
        rank = self.store.ranking('weekly', self.now + 302)
        self.assertEqual(rank['boards']['views'][0]['count'], 10)
        self.assertEqual(rank['boards']['replies'][0]['count'], 2)
        self.assertTrue(rank['warming_up'])

    def test_counter_decrease_does_not_make_negative_or_fake_growth(self):
        self.store.ingest([self.post()], self.now)
        self.store.complete_full(self.now, self.now + 1)
        self.store.ingest([self.post(views=50, replies=5)], self.now + 300)
        self.assertEqual(self.store.ranking('realtime', self.now + 301)['boards']['views'], [])
        self.store.ingest([self.post(views=51, replies=6)], self.now + 600)
        self.assertEqual(self.store.ranking('realtime', self.now + 601)['boards']['views'][0]['count'], 1)

    def test_windows_and_new_post(self):
        self.store.ingest([self.post()], self.now)
        self.store.complete_full(self.now, self.now + 1)
        self.store.ingest([self.post(id=2, published=self.now + 100, views=5)], self.now + 300)
        self.assertEqual(self.store.ranking('realtime', self.now + 400)['boards']['views'][0]['count'], 5)
        self.assertEqual(self.store.ranking('realtime', self.now + 4000)['boards']['views'], [])
        self.assertEqual(self.store.ranking('weekly', self.now + 4000)['boards']['views'][0]['count'], 5)

    def test_outages_and_stale_are_not_complete(self):
        self.store.complete_full(self.now, self.now + 1)
        self.store.complete_full(self.now + 14000, self.now + 14010)
        rank = self.store.ranking('weekly', self.now + 14011)
        self.assertTrue(rank['coverage_gap'])
        self.assertTrue(rank['warming_up'])
        self.assertTrue(self.store.status(self.now + 30000)['stale'])

    def test_restart_persistence(self):
        self.store.ingest([self.post()], self.now)
        with self.store.db:
            self.store.set('full_cursor', {'path': '/new/page/2/', 'pages': 1, 'start': self.now})
        another = Store(self.path)
        try:
            self.assertEqual(another.status(self.now)['topics'], 1)
            self.assertEqual(another.get('full_cursor')['pages'], 1)
        finally:
            another.db.close()

    def test_new_topic_discovered_by_reply_list_backfills_once(self):
        self.store.ingest([self.post()], self.now)
        self.store.complete_full(self.now, self.now + 1)
        self.store.ingest([self.post(id=2, published=None, views=5, replies=1)], self.now + 100)
        self.store.ingest([self.post(id=2, published=None, views=7, replies=2)], self.now + 110)
        self.store.ingest([self.post(id=2, published=self.now + 50, views=8, replies=3)], self.now + 120)
        self.store.ingest([self.post(id=2, published=self.now + 50, views=8, replies=3)], self.now + 130)
        rank = self.store.ranking('weekly', self.now + 140)
        self.assertEqual(rank['boards']['views'][0]['count'], 8)
        self.assertEqual(rank['boards']['replies'][0]['count'], 3)

    def test_full_collector_resumes_cursor_and_completes(self):
        from collector import Collector
        from unittest.mock import patch
        c = Collector(self.store, delay=0)
        with self.store.db:
            self.store.set('last_fast_attempt', self.now)
        with patch.object(c, 'sync_official'), patch('collector.time.time', return_value=self.now), patch.object(c, 'fetch', side_effect=[
            ([self.post()], '/new/page/2/'), ([self.post(id=2)], None)
        ]):
            c.run_once()
            self.assertEqual(self.store.get('full_cursor')['path'], '/new/page/2/')
            self.assertFalse(self.store.status(self.now)['baseline_complete'])
            c.run_once()
            self.assertIsNone(self.store.get('full_cursor'))
            self.assertTrue(self.store.status(self.now)['baseline_complete'])
            self.assertEqual(self.store.status(self.now)['topics'], 2)

    def test_collection_failure_does_not_mark_complete(self):
        from collector import Collector
        from unittest.mock import patch
        c = Collector(self.store, delay=0)
        with self.store.db:
            self.store.set('full_cursor', {'path': '/new/page/2/', 'start': self.now, 'pages': 1})
        with patch.object(c, 'sync_official'), patch.object(c, 'fetch', side_effect=TimeoutError('offline')):
            with self.assertRaises(TimeoutError):
                c.run_once()
        self.assertFalse(self.store.status(self.now)['baseline_complete'])
        self.assertEqual(self.store.get('full_cursor')['path'], '/new/page/2/')

    def test_http_routes_and_no_path_traversal(self):
        server.DATA = Path(self.temp.name)
        with self.store.db:
            for period in ('daily', 'monthly'):
                self.store.set('official_' + period, {'updated_at': self.now, 'boards': {'views': [], 'replies': []}})
        self.store.ingest([self.post()], self.now)
        http = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{http.server_port}'
        try:
            for suffix in ['meta.js', 'user.js']:
                filename = f'shaobing-reply-reminder.{suffix}'
                with urllib.request.urlopen(f'{base}/{filename}') as response:
                    self.assertEqual(response.read(), (server.ROOT / filename).read_bytes())
            for path in ['/healthz', '/api/status'] + [f'/api/rankings/{p}' for p in WINDOWS]:
                with urllib.request.urlopen(base + path) as response:
                    self.assertEqual(response.status, 200)
                    json.load(response)
            for path in ['/api/rankings/evil', '/../backend/server.py', '/stats.sqlite3']:
                with self.assertRaises(urllib.error.HTTPError) as exc:
                    urllib.request.urlopen(base + path)
                self.assertEqual(exc.exception.code, 404)
        finally:
            http.shutdown()
            http.server_close()
            thread.join()

    def test_official_real_parser_order_and_notes(self):
        html = (Path(__file__).parent / 'fixtures/top.html').read_text(encoding='utf-8')
        parsed = parse_official(html)
        self.assertEqual(len(parsed['boards']['replies']), 20)
        self.assertEqual(parsed['boards']['replies'][0]['href'], '/t/15643/')
        self.assertEqual(parsed['boards']['replies'][0]['count'], 83)
        self.assertIn('24', parsed['metric_notes']['replies'])
        with self.assertRaises(ValueError):
            parse_official('<h1>blocked</h1>')
        with self.assertRaises(ValueError):
            parse_official(html.replace('/t/15643/', 'https://evil.test/t/15643/'))

    def test_official_uses_cache_without_local_baseline_and_marks_delay(self):
        with self.assertRaises(ValueError):
            self.store.ranking('daily', self.now)
        cached = {'boards': {'views': [], 'replies': []}, 'updated_at': self.now, 'metric_notes': {}}
        with self.store.db:
            self.store.set('official_daily', cached)
        result = self.store.ranking('daily', self.now + 1)
        self.assertEqual(result['source'], 'official')
        self.assertFalse(result['warming_up'])
        self.assertFalse(result['status']['stale'])
        self.assertTrue(self.store.ranking('daily', self.now + 1801)['status']['stale'])

    def test_official_sync_is_shared_throttled_and_failure_preserves_cache(self):
        from collector import Collector
        from unittest.mock import patch
        html = (Path(__file__).parent / 'fixtures/top.html').read_text(encoding='utf-8')
        c = Collector(self.store)
        with patch.object(c, 'download', return_value=html) as fetch, patch('collector.time.time', return_value=self.now):
            c.sync_official(self.now)
            c.sync_official(self.now + 899)
            self.assertEqual(fetch.call_count, 2)
        with patch.object(c, 'download', side_effect=TimeoutError('offline')), patch('collector.LOG.exception'):
            c.sync_official(self.now + 900)
        self.assertEqual(self.store.get('official_daily')['updated_at'], self.now)
        self.assertEqual(self.store.get('official_daily_error'), 'offline')

    def test_hourly_full_scan_and_nine_day_retention(self):
        from collector import Collector
        from unittest.mock import patch
        with self.store.db:
            self.store.set('last_full_at', self.now)
            self.store.set('last_fast_attempt', self.now + 3599)
            self.store.db.execute('INSERT INTO deltas VALUES(1,?,0,1,1)', (self.now - 10 * 86400,))
            self.store.db.execute('INSERT INTO deltas VALUES(1,?,0,1,1)', (self.now - 8 * 86400,))
        c = Collector(self.store)
        with patch.object(c, 'sync_official'), patch.object(c, 'fetch', return_value=([self.post()], None)) as fetch, patch('collector.time.time', return_value=self.now + 3599):
            c.run_once()
            fetch.assert_not_called()
        with patch.object(c, 'sync_official'), patch.object(c, 'fetch', return_value=([self.post()], None)) as fetch, patch('collector.time.time', return_value=self.now + 3600):
            c.run_once()
            fetch.assert_called_once_with('/new/')
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM deltas').fetchone()[0], 1)


if __name__ == '__main__':
    unittest.main()
