"""Online SQLite backup; retain seven daily copies."""
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

directory = Path(os.environ.get('SBHOT_DATA', '/var/lib/sbhot'))
backups = directory / 'backups'
backups.mkdir(exist_ok=True)
target = backups / (datetime.now(timezone.utc).strftime('%Y-%m-%d') + '.sqlite3')
with sqlite3.connect(directory / 'stats.sqlite3') as source, sqlite3.connect(target) as dest:
    source.backup(dest)
for old in sorted(backups.glob('*.sqlite3'))[:-7]:
    old.unlink()
