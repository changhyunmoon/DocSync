import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateInstallerPolicy } from './lib/installer-policy.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(project, '.web-build');
const site = path.join(build, 'site');
const renderer = path.join(build, 'renderer');
function run(script, args = [], cwd = project) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(script)} failed (${result.status})`);
}

// All generated files stay in this one disposable directory.
if (path.dirname(build) !== project) throw new Error('Invalid build directory');
await fs.rm(build, { recursive: true, force: true });
try {
  await fs.cp(path.join(project, 'dist'), site, { recursive: true });
  const installer = JSON.parse(await fs.readFile(path.join(site, 'download/manifest.json'), 'utf8'));
  const signedInstaller = validateInstallerPolicy(installer);
  const version = installer.filename.match(/^DocSync-Setup-(.+)\.exe$/)[1];
  const homePath = path.join(site, 'index.html');
  let home = (await fs.readFile(homePath, 'utf8')).replace(/(<small data-installer-version>)[^<]*(<\/small>)/,
    (_, open, close) => `${open}설치 파일 · v${version}${close}`);
  if (signedInstaller) {
    home = home.replace(/(<small class="download-warning" data-installer-warning>)[^<]*(<\/small>)/,
      (_, open, close) => `${open}코드 서명된 설치 파일입니다. Windows의 앱 평판이나 보안 정책에 따라 추가 확인이 나타날 수 있습니다.${close}`);
  }
  await fs.writeFile(homePath, home);
  run(path.join(project, 'desktop/node_modules/vite/bin/vite.js'),
    ['build', '--config', 'vite.web.config.ts'], path.join(project, 'desktop'));
  const app = path.join(site, 'app');
  await fs.rm(path.join(app, 'assets'), { recursive: true, force: true });
  await fs.cp(path.join(renderer, 'assets'), path.join(app, 'assets'), { recursive: true });
  const html = (await fs.readFile(path.join(renderer, 'index.html'), 'utf8'))
    .replace('<script type="module"', '<script src="./web-api.js"></script>\n    <script type="module"')
    .replace('</head>', '    <link rel="stylesheet" href="./web.css">\n  </head>');
  if (!html.includes('web-api.js') || !html.includes('web.css')) throw new Error('Browser API injection failed');
  await fs.writeFile(path.join(app, 'index.html'), html);
  run(path.join(project, 'scripts/generate-data.mjs'), [site]);
  run(path.join(project, 'scripts/check-web-api.mjs'), [site]);
  run(path.join(project, 'scripts/check-web-site.mjs'), [site]);
  console.log(`Web build ready: ${site}`);
} catch (error) {
  await fs.rm(site, { recursive: true, force: true });
  throw error;
} finally {
  await fs.rm(renderer, { recursive: true, force: true });
}
