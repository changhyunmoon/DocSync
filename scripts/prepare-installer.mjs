import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(project, 'desktop/release/DocSync Setup 0.1.0.exe');
const target = path.join(project, 'dist/download');
const bytes = await fs.readFile(source);
const chunkSize = 20 * 1024 * 1024;
await fs.mkdir(target, { recursive: true });
const parts = [];
for (let start=0, i=0; start<bytes.length; start+=chunkSize, i++) {
  const chunk=bytes.subarray(start,Math.min(start+chunkSize,bytes.length));
  const name=`docsync-setup.part${String(i+1).padStart(2,'0')}.bin`;
  await fs.writeFile(path.join(target,name),chunk);
  parts.push({name,size:chunk.length});
}
const manifest={filename:'DocSync-Setup-0.1.0.exe',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),parts};
await fs.writeFile(path.join(target,'manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({size:manifest.size,parts:parts.length,sha256:manifest.sha256}));
