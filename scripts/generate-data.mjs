import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const desktop = path.join(project, 'desktop');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(desktop, 'node_modules/esbuild'));
const bundle = path.join(project, 'scripts/.demo-bundle.cjs');
await esbuild.build({
  entryPoints: [path.join(desktop, 'src/main/mock.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  alias: { '@shared': path.join(desktop, 'src/shared') },
  outfile: bundle
});
const { DEMO_FILES, SAMPLE_TEXT, sampleDrafts } = require(bundle);
await fs.mkdir(path.join(project, 'dist'), { recursive: true });
await fs.writeFile(path.join(project, 'dist/demo-data.json'), JSON.stringify({ files: DEMO_FILES, meeting: SAMPLE_TEXT, items: sampleDrafts() }), 'utf8');
await fs.rm(bundle);
console.log(`Synced ${Object.keys(DEMO_FILES).length} files and ${sampleDrafts().length} decisions.`);
