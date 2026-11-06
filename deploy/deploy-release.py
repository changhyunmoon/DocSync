#!/usr/bin/env python3
"""Atomically activate a static artifact, verify HTTP, and roll back on failure."""
import fcntl
from html.parser import HTMLParser
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path(os.environ.get('DOCSYNC_DEPLOY_ROOT', '/srv/docsync'))
HEALTH_URL = os.environ.get('DOCSYNC_HEALTH_URL', 'http://127.0.0.1:8088')


def switch(target):
    link = ROOT / '.current-next'
    link.unlink(missing_ok=True)
    link.symlink_to(target)
    link.replace(ROOT / 'current')


def verify_files(site, revision):
    for name in ['index.html', 'app/index.html', 'app/web-api.js', 'app/web.css', 'demo-data.json']:
        if not (site / name).is_file():
            raise ValueError(f'Missing web file: {name}')
    if (site / 'health.txt').read_text().strip() != revision:
        raise ValueError('Artifact revision does not match the requested commit')
    class References(HTMLParser):
        def handle_starttag(self, tag, attrs):
            for key, value in attrs:
                if key in ('src', 'href') and value and not value.startswith(('#', 'http:', 'https:', 'data:')):
                    candidate = (self.base / value.split('#')[0].split('?')[0]).resolve()
                    if not candidate.is_relative_to(site.resolve()) or not candidate.is_file():
                        raise ValueError(f'Missing or unsafe asset: {value}')
    for name in ['index.html', 'app/index.html']:
        parser = References()
        parser.base = (site / name).parent
        parser.feed((site / name).read_text())


def check_http(revision):
    last_error = None
    for _ in range(10):
        try:
            req = urllib.request.Request(HEALTH_URL + '/health.txt', headers={'Cache-Control': 'no-cache'})
            with urllib.request.urlopen(req, timeout=3) as response:
                if response.read().decode().strip() != revision:
                    raise RuntimeError('HTTP returned a different revision')
            for endpoint in ['/', '/app/index.html', '/app/web-api.js', '/demo-data.json']:
                request = urllib.request.Request(HEALTH_URL + endpoint, method='HEAD')
                with urllib.request.urlopen(request, timeout=3) as response:
                    if response.status != 200:
                        raise RuntimeError(f'HTTP failed: {endpoint}')
            return
        except Exception as error:
            last_error = error
            time.sleep(1)
    raise RuntimeError(f'Health check failed: {last_error}')


def deploy(archive, release_id):
    if not re.fullmatch(r'[0-9a-f]{40}-[0-9]+-[0-9]+', release_id):
        raise ValueError('Invalid release ID')
    revision = release_id[:40]
    releases = ROOT / 'releases'
    staging = ROOT / 'staging'
    releases.mkdir(parents=True, exist_ok=True)
    staging.mkdir(parents=True, exist_ok=True)
    with (ROOT / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        destination = releases / release_id
        if destination.exists():
            raise ValueError('Release ID already exists; rerun with a new attempt number')
        temporary = Path(tempfile.mkdtemp(prefix=release_id + '.', dir=staging))
        previous = os.readlink(ROOT / 'current') if (ROOT / 'current').is_symlink() else None
        activated = False
        try:
            with tarfile.open(archive, 'r:gz') as bundle:
                members = bundle.getmembers()
                if len(members) > 10000 or sum(m.size for m in members) > 512 * 1024 * 1024:
                    raise ValueError('Artifact is too large')
                for member in members:
                    name = PurePosixPath(member.name)
                    if name.is_absolute() or '..' in name.parts or not (member.isfile() or member.isdir()):
                        raise ValueError(f'Unsafe archive entry: {member.name}')
                bundle.extractall(temporary, members=members, filter='data')
            verify_files(temporary, revision)
            for entry in temporary.rglob('*'):
                entry.chmod(0o755 if entry.is_dir() else 0o644)
            temporary.chmod(0o755)
            temporary.rename(destination)
            switch('releases/' + release_id)
            activated = True
            check_http(revision)
        except Exception:
            if activated:
                if previous:
                    switch(previous)
                else:
                    (ROOT / 'current').unlink(missing_ok=True)
            if destination.exists():
                shutil.rmtree(destination)
            raise
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
        # Always preserve current and the release we could roll back to.
        keep = {destination.name}
        if previous:
            keep.add(Path(previous).name)
        for entry in sorted(releases.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if entry.name not in keep and entry.is_dir() and not entry.is_symlink():
                if re.fullmatch(r'[0-9a-f]{40}-[0-9]+-[0-9]+', entry.name):
                    shutil.rmtree(entry)
        print(f'Deployed {release_id}; retained {len(keep)} releases', flush=True)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: deploy-release.py <artifact.tar.gz> <commit-run-attempt>')
    deploy(Path(sys.argv[1]), sys.argv[2])
