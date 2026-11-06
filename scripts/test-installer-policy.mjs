import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateInstallerPolicy } from './lib/installer-policy.mjs';

const baseline = JSON.parse(fs.readFileSync(new URL('../dist/download/manifest.json', import.meta.url), 'utf8'));
test('already-published installer is allowed while certificate is pending', () => {
  assert.equal(validateInstallerPolicy(baseline), Boolean(baseline.signature));
});
test('a different unsigned executable is rejected', () => {
  const changed = structuredClone(baseline);
  delete changed.signature;
  changed.sha256 = '0'.repeat(64);
  assert.throws(() => validateInstallerPolicy(changed), /unsigned installer/);
});
test('path traversal, duplicate parts and invalid total size are rejected', () => {
  for (const mutate of [
    m => { m.parts[0].name = '../credentials'; },
    m => { m.parts.push(m.parts[0]); },
    m => { m.size++; }
  ]) {
    const changed = structuredClone(baseline);
    mutate(changed);
    assert.throws(() => validateInstallerPolicy(changed));
  }
});
test('signature metadata without a timestamp is rejected', () => {
  const changed = structuredClone(baseline);
  changed.signature = { status: 'Valid', thumbprint: 'A'.repeat(40), publisher: 'CN=Test', timestamped: false };
  assert.throws(() => validateInstallerPolicy(changed));
});
test('installer preparation fails before publishing when no certificate is configured', () => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const manifestPath = path.join(project, 'dist/download/manifest.json');
  const before = fs.readFileSync(manifestPath);
  const result = spawnSync(process.execPath, ['scripts/prepare-installer.mjs'], {
    cwd: project, encoding: 'utf8', env: { ...process.env, DOCSYNC_SIGN_CERT_SHA1: '' }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /issued code-signing certificate thumbprint/);
  assert.deepEqual(fs.readFileSync(manifestPath), before);
});
