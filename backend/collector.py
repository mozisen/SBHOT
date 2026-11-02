"""Rate-limited sequential collector. No credentials or private forum endpoints."""
import logging
import os
import time
import urllib.request
from pathlib import Path

from core import ORIGIN, Store, parse_page, parse_official, OFFICIAL_PATHS, OFFICIAL_INTERVAL, FULL_INTERVAL

LOG = logging.getLogger('sbhot')


class Collector:
    def __init__(self, store, delay=2):
        self.store = store
        self.delay = delay
        self.last_request = 0

    def download(self, path):
        time.sleep(max(0, self.delay - (time.monotonic() - self.last_request)))
        self.last_request = time.monotonic()
        req = urllib.request.Request(ORIGIN + path, headers={
            'User-Agent': 'SBHOT/2.1 (+https://sbhot.voee.de/) public-topic-statistics',
            'Accept': 'text/html', 'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(req, timeout=20) as response:
            if response.url != ORIGIN + path:
                raise ValueError('Unexpected forum redirect')
            raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise ValueError('Page exceeds size limit')
            return raw.decode('utf-8')

    def fetch(self, path):
        return parse_page(self.download(path), path)

    def sync_official(self, now):
        for period, path in OFFICIAL_PATHS.items():
            key = 'official_' + period
            if now - self.store.get(key + '_attempt', 0) < OFFICIAL_INTERVAL:
                continue
            with self.store.db:
                self.store.set(key + '_attempt', now)
            try:
                parsed = parse_official(self.download(path))
                with self.store.db:
                    self.store.set(key, {**parsed, 'updated_at': int(time.time())})
                    self.store.set(key + '_error', None)
            except Exception as exc:
                LOG.exception('Official %s refresh failed; preserving last cache', period)
                with self.store.db:
                    self.store.set(key + '_error', str(exc)[:200])

    def fast(self):
        start = int(time.time())
        cutoff = self.store.get('last_fast_at', start - 900) - 300
        path, visited = '/', set()
        # Follow all recently active pages, not just a fixed top-N sample.
        while path:
            if path in visited or len(visited) >= 5000:
                raise ValueError('Fast pagination cycle/limit')
            visited.add(path)
            posts, next_path = self.fetch(path)
            self.store.ingest(posts, int(time.time()))
            ordinary = [p for p in posts if not p['pinned']]
            if ordinary and max(p['activity'] for p in ordinary) < cutoff:
                break
            path = next_path
        posts, _ = self.fetch('/new/')
        self.store.ingest(posts, int(time.time()))
        with self.store.db:
            self.store.set('last_fast_at', start)
            self.store.set('fast_error', None)

    def run_once(self):
        now = int(time.time())
        self.sync_official(now)
        cursor = self.store.get('full_cursor')
        if cursor or now - self.store.get('last_full_at', 0) >= FULL_INTERVAL:
            if not cursor:
                cursor = {'path': '/new/', 'start': now, 'pages': 0}
            path = cursor['path']
            if cursor['pages'] >= 5000:
                raise ValueError('Full pagination limit exceeded')
            posts, next_path = self.fetch(path)
            self.store.ingest(posts, int(time.time()))
            if next_path == path:
                raise ValueError('Full pagination loop')
            if next_path:
                with self.store.db:
                    self.store.set('full_cursor', {'path': next_path, 'start': cursor['start'], 'pages': cursor['pages'] + 1})
            else:
                self.store.complete_full(cursor['start'], int(time.time()))
                LOG.info('Full scan complete: %s pages', cursor['pages'] + 1)
        if now - self.store.get('last_fast_attempt', 0) >= 300:
            with self.store.db:
                self.store.set('last_fast_attempt', now)
            try:
                self.fast()
            except Exception as exc:
                LOG.exception('Fast scan failed')
                with self.store.db:
                    self.store.set('fast_error', str(exc)[:200])


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    directory = Path(os.environ.get('SBHOT_DATA', '/var/lib/sbhot'))
    directory.mkdir(parents=True, exist_ok=True)
    store = Store(str(directory / 'stats.sqlite3'))
    collector = Collector(store)
    while True:
        try:
            collector.run_once()
            time.sleep(2 if store.get('full_cursor') else 10)
        except Exception as exc:
            LOG.exception('Full scan failed; retrying cursor in 60 seconds')
            with store.db:
                store.set('full_error', str(exc)[:200])
            time.sleep(60)


if __name__ == '__main__':
    main()
