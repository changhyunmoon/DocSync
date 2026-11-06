#!/usr/bin/env python3
"""Exercise real extraction, symlink switching and HTTP rollback in an isolated root."""
import http.server
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deployment', Path(__file__).with_name('deploy-release.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='docsync-deploy-test-')
        self.root = Path(self.temporary.name)
        deployment.ROOT = self.root / 'web'
        deployment.ROOT.mkdir()
        self.fail_http = False
        test = self
        class Handler(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(deployment.ROOT / 'current'), **kwargs)

            def do_GET(self):
                if test.fail_http:
                    self.send_error(503)
                else:
                    super().do_GET()

            def log_message(self, *args):
                pass
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        deployment.HEALTH_URL = f'http://127.0.0.1:{self.server.server_port}'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def artifact(self, letter, run=1, unsafe=None):
        revision = letter * 40
        archive = self.root / f'{letter}-{run}.tar.gz'
        files = {
            'index.html': '<title>DocSync</title><iframe src="./app/index.html"></iframe>',
            'app/index.html': '<script src="./web-api.js"></script><link href="./web.css">',
            'app/web-api.js': 'window.api = {};',
            'app/web.css': 'body {}',
            'demo-data.json': '{}',
            'health.txt': revision,
        }
        with tarfile.open(archive, 'w:gz') as bundle:
            for name, value in files.items():
                data = value.encode()
                info = tarfile.TarInfo('./' + name)
                info.size = len(data)
                bundle.addfile(info, io.BytesIO(data))
            if unsafe:
                bundle.addfile(unsafe)
        return archive, f'{revision}-{run}-1'

    def test_success_retention_and_failed_health_rollback(self):
        for letter in 'abc':
            archive, release = self.artifact(letter)
            deployment.deploy(archive, release)
            self.assertEqual((deployment.ROOT / 'current/health.txt').read_text(), letter * 40)
        self.assertEqual(len(list((deployment.ROOT / 'releases').iterdir())), 2)
        archive, release = self.artifact('d')
        self.fail_http = True
        with patch.object(deployment.time, 'sleep'), self.assertRaisesRegex(RuntimeError, 'Health check failed'):
            deployment.deploy(archive, release)
        self.assertEqual((deployment.ROOT / 'current/health.txt').read_text(), 'c' * 40)
        self.assertFalse((deployment.ROOT / 'releases' / release).exists())
        self.assertEqual(list((deployment.ROOT / 'staging').iterdir()), [])

    def test_traversal_and_links_are_rejected(self):
        traversal = tarfile.TarInfo('../../escape.txt')
        link = tarfile.TarInfo('unsafe-link')
        link.type = tarfile.SYMTYPE
        link.linkname = '/etc/passwd'
        for index, unsafe in enumerate([traversal, link]):
            archive, release = self.artifact('e', index + 1, unsafe)
            with self.assertRaisesRegex(ValueError, 'Unsafe archive entry'):
                deployment.deploy(archive, release)
        self.assertFalse((self.root / 'escape.txt').exists())
        self.assertEqual(list((deployment.ROOT / 'staging').iterdir()), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
