import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { validateInstallerPolicy } from './lib/installer-policy.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = process.argv[2] ? path.resolve(process.argv[2]) : path.join(project, 'dist');
for (const name of ['index.html', 'app/index.html']) {
  const html = await fs.readFile(path.join(site, name), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    const link = match[1];
    if (/^(?:https?:|data:)/.test(link)) continue;
    const file = path.resolve(path.dirname(path.join(site, name)), link.split(/[?#]/)[0]);
    assert.ok(file.startsWith(site + path.sep), `Asset outside site: ${link}`);
    assert.ok((await fs.stat(file)).isFile(), `Missing asset: ${link}`);
  }
}
const home = await fs.readFile(path.join(site, 'index.html'), 'utf8');
if (home.includes('data-desktop-status="coming-soon"')) {
  assert.ok(!home.includes('./download.js'), 'Coming-soon page must not load the downloader');
  assert.ok(!home.includes('desktop-download'), 'Coming-soon page must not expose active download controls');
  for (const button of home.matchAll(/<button\b[^>]*class="[^"]*desktop-status[^"]*"[^>]*>/g)) {
    assert.match(button[0], /\bdisabled\b/, 'Coming-soon buttons must be disabled');
  }
  console.log('Web assets verified; desktop download is coming soon.');
} else {
  const manifest = JSON.parse(await fs.readFile(path.join(site, 'download/manifest.json'), 'utf8'));
  const signed = validateInstallerPolicy(manifest);
  const hash = crypto.createHash('sha256');
  let size = 0;
  for (const part of manifest.parts) {
    assert.equal(path.basename(part.name), part.name);
    const data = await fs.readFile(path.join(site, 'download', part.name));
    assert.equal(data.length, part.size);
    hash.update(data);
    size += data.length;
  }
  assert.equal(size, manifest.size);
  assert.equal(hash.digest('hex'), manifest.sha256);
  console.log('Web assets and installer SHA-256 verified.');
  console.log(signed ? 'Installer signature will be independently verified on Windows before deployment.' : 'Existing unsigned demo retained; new unsigned installers are blocked.');
}
