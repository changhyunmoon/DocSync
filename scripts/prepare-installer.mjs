import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateInstallerPolicy } from './lib/installer-policy.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = JSON.parse(await fs.readFile(path.join(project, 'desktop/package.json'), 'utf8'));
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`);
  return args[index + 1];
}
const source = path.resolve(option('--installer', path.join(project, `desktop/release-signed/DocSync-Setup-${desktop.version}.exe`)));
const thumbprint = (option('--expected-thumbprint', process.env.DOCSYNC_SIGN_CERT_SHA1) || '').replace(/\s/g, '').toUpperCase();
if (!/^[A-F0-9]{40}$/.test(thumbprint)) throw new Error('Set DOCSYNC_SIGN_CERT_SHA1 to your issued code-signing certificate thumbprint.');
if (process.platform !== 'win32') throw new Error('Installer signature verification must run on Windows.');

// Verify the final Setup executable before changing any published download file.
const verification = spawnSync('powershell.exe', ['-NoProfile', '-File',
  path.join(project, 'scripts/windows/Test-WindowsSignature.ps1'),
  '-InstallerPath', source, '-ExpectedThumbprint', thumbprint], { encoding: 'utf8' });
if (verification.error) throw verification.error;
if (verification.status !== 0) throw new Error(verification.stderr.trim() || 'Signature verification failed.');
const signature = JSON.parse(verification.stdout.replace(/^\uFEFF/, '').trim());
const bytes = await fs.readFile(source);
const target = path.join(project, 'dist/download');
const chunkSize = 20 * 1024 * 1024;
const parts = [];
for (let start = 0, index = 1; start < bytes.length; start += chunkSize, index++) {
  const chunk = bytes.subarray(start, Math.min(start + chunkSize, bytes.length));
  parts.push({ name: `docsync-setup.part${String(index).padStart(2, '0')}.bin`, size: chunk.length });
}
const manifest = {
  filename: `DocSync-Setup-${desktop.version}.exe`, version: desktop.version,
  size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), parts, signature
};
validateInstallerPolicy(manifest);
await fs.mkdir(target, { recursive: true });
for (let index = 0; index < parts.length; index++) {
  await fs.writeFile(path.join(target, parts[index].name), bytes.subarray(index * chunkSize, (index + 1) * chunkSize));
}
// Remove obsolete parts when the next installer contains fewer chunks.
const keep = new Set(parts.map(part => part.name));
for (const name of await fs.readdir(target)) {
  if (/^docsync-setup\.part[0-9]{2,3}\.bin$/.test(name) && !keep.has(name)) {
    await fs.unlink(path.join(target, name));
  }
}
await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Verified signed installer packaged: ${manifest.filename} (${parts.length} parts)`);
