#!/usr/bin/env python3
"""Only clean DocSync-owned directories; never prune shared services or system caches."""
import fcntl
import os
from pathlib import Path
import shutil
import sys
import time

ROOT = Path('/srv/docsync')
RUNNER = Path('/opt/docsync/runner')
DAY = 86400


def remove(path, parent):
    # Do not follow a replaced symlink into another application.
    if path.parent.resolve() != parent.resolve():
        raise RuntimeError(f'Unexpected cleanup path: {path}')
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path)


def main():
    now = time.time()
    with (ROOT / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for folder in [ROOT / 'staging', RUNNER / '_work/_temp']:
            if not folder.exists():
                continue
            pattern = '*' if folder == ROOT / 'staging' else 'docsync-deploy.*'
            for entry in folder.glob(pattern):
                if now - entry.lstat().st_mtime > DAY:
                    remove(entry, folder)
    diagnostics = RUNNER / '_diag'
    logs = sorted(diagnostics.glob('*.log'), key=lambda p: p.stat().st_mtime, reverse=True)
    for index, entry in enumerate(logs):
        if now - entry.stat().st_mtime > 7 * DAY or (index >= 20 and now - entry.stat().st_mtime > 3600):
            remove(entry, diagnostics)
    # Runner software updates can leave versioned binaries behind. Keep the active
    # target and at least the newest two versions; never remove bin/externals itself.
    for prefix in ['bin', 'externals']:
        active = (RUNNER / prefix).resolve()
        versions = sorted(RUNNER.glob(prefix + '.*'), key=lambda p: p.stat().st_mtime, reverse=True)
        for entry in versions[2:]:
            if entry.resolve() != active and now - entry.lstat().st_mtime > DAY:
                remove(entry, RUNNER)
    if '--after-job' in sys.argv:
        # There is one job at a time on this dedicated runner. The hook runs after
        # action post steps, so no checkout or downloaded action is retained.
        work = RUNNER / '_work'
        for name in ['DocSync', '_actions']:
            remove(work / name, work)
        temporary = work / '_temp'
        if temporary.exists():
            for entry in temporary.glob('docsync-deploy.*'):
                remove(entry, temporary)
    print('DocSync cleanup completed', flush=True)


if __name__ == '__main__':
    main()
