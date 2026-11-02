"""Public-page parsing and persistent, observation-time counter deltas."""
import json
import re
import sqlite3
from datetime import datetime
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

ORIGIN = 'https://sb.sb'
WINDOWS = {'realtime': 3600, 'daily': 86400, 'weekly': 604800, 'monthly': 2592000}
OFFICIAL_PATHS = {'daily': '/pages/top/', 'monthly': '/pages/top/30d/'}
FULL_INTERVAL = 3600
FULL_STALE = 10800
OFFICIAL_INTERVAL = 900


def parse_official(html):
    doc = BeautifulSoup(html, 'html5lib')
    boards, notes = {}, {}
    for section in doc.select('.top-board'):
        heading = section.select_one('.top-board-title')
        title = re.sub(r'\s+', '', heading.get_text()) if heading else ''
        metric = {'热门主题·浏览': 'views', '热门主题·回复': 'replies'}.get(title)
        if not metric:
            continue
        note = section.select_one('.top-board-note')
        # Optional closing </p> in upstream markup must not absorb the following list.
        notes[metric] = ''.join(str(t) for t in note.find_all(string=True, recursive=False)).strip() if note else ''
        boards[metric], seen = [], set()
        for row in section.select('.top-row'):
            link, score = row.select_one('.top-thread-title[href]'), row.select_one('.top-score')
            if not link or not score:
                raise ValueError('Invalid official topic row')
            url = urlparse(urljoin(ORIGIN, link['href']))
            if url.scheme != 'https' or url.netloc != 'sb.sb' or not re.fullmatch(r'/t/\d+/', url.path):
                raise ValueError('Unsafe official topic URL')
            for unit in score.select('.top-unit'):
                unit.decompose()
            count = score.get_text(strip=True).replace(',', '')
            if not count.isdigit() or not link.get_text(strip=True):
                raise ValueError('Invalid official count/title')
            if url.path in seen:
                continue
            seen.add(url.path)
            author, forum = row.select_one('.top-by'), row.select_one('.top-node')
            boards[metric].append({'href': url.path, 'title': link.get_text(strip=True), 'count': int(count),
                                   'author': author.get_text(strip=True) if author else '',
                                   'forum': forum.get_text(strip=True) if forum else ''})
    if set(boards) != {'views', 'replies'}:
        raise ValueError('Missing official ranking boards')
    return {'boards': boards, 'metric_notes': notes}


def timestamp(value):
    return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp())


def parse_page(html, path):
    doc = BeautifulSoup(html, 'html5lib')
    container = doc.select_one('ul.post-list')
    if container is None:
        raise ValueError('Missing public topic list')
    result = []
    for row in container.select('li.post-item'):
        link = row.select_one('a.post-title[href]')
        if not link:
            raise ValueError('Missing topic link')
        url = urlparse(urljoin(ORIGIN, link['href']))
        match = re.fullmatch(r'/t/(\d+)/', url.path)
        if url.scheme != 'https' or url.netloc != 'sb.sb' or not match:
            raise ValueError('Unexpected topic URL')
        meta = row.select_one('.post-meta')
        spans = meta.find_all('span', recursive=False) if meta else []
        counts = [int(s.get_text(strip=True).replace(',', '')) for s in spans
                  if re.fullmatch(r'[\d,]+', s.get_text(strip=True)) and not s.select_one('a, time')]
        if len(counts) != 2:
            raise ValueError('Unknown view/reply count layout')
        author = meta.select_one('a[href^="/u/"]')
        forum = row.select_one('.post-forum-badge, .post-forum-meta a')
        times = [timestamp(t['datetime']) for t in meta.select('time[datetime]')]
        if not times:
            raise ValueError('Missing topic timestamp')
        is_new = path.startswith('/new/')
        result.append({'id': int(match[1]), 'title': link.get_text(strip=True),
                       'author': author.get_text(strip=True) if author else '',
                       'forum': forum.get_text(strip=True) if forum else '',
                       'views': counts[0], 'replies': counts[1],
                       'published': times[0] if is_new else None,
                       'activity': times[-1], 'pinned': 'topic-pinned' in row.get('class', [])})
    next_link = doc.select_one('.pagination .is-next a[href]')
    next_path = None
    if next_link:
        url = urlparse(urljoin(ORIGIN, next_link['href']))
        pattern = r'/new/page/\d+/' if path.startswith('/new/') else r'/page/\d+/'
        if url.netloc != 'sb.sb' or url.scheme != 'https' or not re.fullmatch(pattern, url.path) or url.query:
            raise ValueError('Unexpected pagination URL')
        next_path = url.path
    if not result:
        raise ValueError('Unexpected empty public topic list')
    return result, next_path


class Store:
    def __init__(self, path):
        self.db = sqlite3.connect(path, timeout=20)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
          PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS topics(id INTEGER PRIMARY KEY,title TEXT,author TEXT,forum TEXT,
            views INTEGER,replies INTEGER,published INTEGER,seen INTEGER);
          CREATE TABLE IF NOT EXISTS deltas(id INTEGER,at INTEGER,span_start INTEGER,views INTEGER,replies INTEGER);
          CREATE INDEX IF NOT EXISTS delta_time ON deltas(at,id);
          CREATE TABLE IF NOT EXISTS full_runs(start INTEGER PRIMARY KEY,end INTEGER);
        ''')

    def get(self, key, fallback=None):
        row = self.db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else fallback

    def set(self, key, value):
        self.db.execute('INSERT OR REPLACE INTO meta VALUES(?,?)', (key, json.dumps(value)))

    def ingest(self, posts, now):
        with self.db:
            self.set('started_at', self.get('started_at', now))
            for p in posts:
                prev = self.db.execute('SELECT * FROM topics WHERE id=?', (p['id'],)).fetchone()
                # Counts seen before our baseline are not historical activity in a new window.
                is_new = p['published'] is not None and p['published'] >= self.get('started_at')
                dv = max(0, p['views'] - prev['views']) if prev else p['views'] if is_new else 0
                dr = max(0, p['replies'] - prev['replies']) if prev else p['replies'] if is_new else 0
                # The reply-sorted page has no publication timestamp. Backfill initial
                # counts exactly once when /new/ confirms this was created after startup.
                if prev and prev['published'] is None and is_new:
                    dv, dr = p['views'], p['replies']
                    # Prior deltas for this topic were already counted; do not duplicate them.
                    counted = self.db.execute('SELECT COALESCE(SUM(views),0),COALESCE(SUM(replies),0) FROM deltas WHERE id=?', (p['id'],)).fetchone()
                    dv, dr = max(0, dv - counted[0]), max(0, dr - counted[1])
                if dv or dr:
                    self.db.execute('INSERT INTO deltas VALUES(?,?,?,?,?)',
                                    (p['id'], now, prev['seen'] if prev else p['published'], dv, dr))
                published = p['published'] if p['published'] is not None else prev['published'] if prev else None
                self.db.execute('INSERT OR REPLACE INTO topics VALUES(?,?,?,?,?,?,?,?)',
                                (p['id'], p['title'], p['author'], p['forum'], p['views'], p['replies'], published, now))
            self.set('last_observation', now)

    def complete_full(self, start, end):
        with self.db:
            self.set('baseline_at', self.get('baseline_at', end))
            self.set('last_full_start', start)
            self.set('last_full_at', end)
            self.set('full_cursor', None)
            self.set('full_error', None)
            self.db.execute('INSERT OR REPLACE INTO full_runs VALUES(?,?)', (start, end))
            self.db.execute('DELETE FROM deltas WHERE at < ?', (end - 9 * 86400,))
            self.db.execute('DELETE FROM full_runs WHERE end < ?', (end - 10 * 86400,))

    def status(self, now):
        baseline = self.get('baseline_at')
        last_full = self.get('last_full_at')
        return {'started_at': self.get('started_at'), 'baseline_at': baseline,
                'last_observation': self.get('last_observation'), 'last_full_at': last_full,
                'full_cursor': self.get('full_cursor'), 'full_error': self.get('full_error'),
                'fast_error': self.get('fast_error'), 'last_fast_at': self.get('last_fast_at'),
                'topics': self.db.execute('SELECT COUNT(*) FROM topics').fetchone()[0],
                'baseline_complete': bool(baseline),
                'stale': not last_full or now - last_full > FULL_STALE,
                'sampling': {'active_seconds': 300, 'full_seconds': FULL_INTERVAL, 'official_seconds': OFFICIAL_INTERVAL},
                'sources': {'realtime': 'collected', 'weekly': 'collected', 'daily': 'official', 'monthly': 'official'},
                'official': {p: {'updated_at': (self.get('official_' + p) or {}).get('updated_at'),
                                 'error': self.get('official_' + p + '_error')} for p in OFFICIAL_PATHS},
                'semantics': 'snapshot_delta_at_observation_time'}

    def ranking(self, period, now):
        window = WINDOWS[period]
        if period in OFFICIAL_PATHS:
            cached = self.get('official_' + period)
            if not cached:
                raise ValueError('Official ranking not yet available')
            stale = now - cached['updated_at'] > 2 * OFFICIAL_INTERVAL
            error = self.get('official_' + period + '_error')
            return {**cached, 'schema_version': 1, 'source': 'official', 'period': period,
                    'source_url': ORIGIN + OFFICIAL_PATHS[period], 'window_seconds': window,
                    'generated_at': now, 'collected_since': None, 'warming_up': False,
                    'coverage_gap': False, 'observed_seconds': window,
                    'status': {'baseline_complete': True, 'stale': stale, 'refresh_error': error}}
        status = self.status(now)
        baseline = status['baseline_at']
        since = max(now - window, baseline or now)
        gap = self.db.execute('''SELECT 1 FROM (
          SELECT start, LAG(end) OVER (ORDER BY start) previous_end FROM full_runs
        ) WHERE start > ? AND previous_end IS NOT NULL AND start-previous_end > ? LIMIT 1''',
                              (now - window, FULL_STALE)).fetchone() is not None
        ready = bool(baseline and now - baseline >= window and not status['stale'] and not gap)
        boards = {}
        for metric in ('views', 'replies'):
            # Column name is from the fixed tuple above, never from a request.
            rows = self.db.execute(f'''SELECT t.id,t.title,t.author,t.forum,SUM(d.{metric}) count
              FROM deltas d JOIN topics t ON t.id=d.id
              WHERE d.at > ? AND d.at <= ? AND t.seen >= ?
              GROUP BY t.id HAVING count > 0 ORDER BY count DESC,t.id DESC LIMIT 100''',
                                   (since, now, self.get('last_full_start', 0))).fetchall()
            boards[metric] = [dict(r, href=f"/t/{r['id']}/") for r in rows]
        return {'schema_version': 1, 'source': 'collected', 'period': period, 'window_seconds': window,
                'generated_at': now, 'updated_at': status['last_observation'],
                'collected_since': baseline, 'warming_up': not ready, 'coverage_gap': gap,
                'observed_seconds': max(0, min(window, now - baseline)) if baseline else 0,
                'status': status, 'boards': boards}
