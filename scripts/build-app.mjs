// 데스크톱 앱 화면(렌더러 빌드)을 웹 데모 dist/app에 넣는다.
// web-api.js(브라우저용 IPC 대체)와 web.css(웹 전용 스타일)는 그대로 두고 index.html에 다시 연결한다.
// 먼저 desktop/에서 `npm run build`를 실행해야 한다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = path.join(project, 'desktop/out/renderer');
const app = path.join(project, 'dist/app');

const html = await fs.readFile(path.join(built, 'index.html'), 'utf8');
await fs.rm(path.join(app, 'assets'), { recursive: true, force: true });
await fs.cp(path.join(built, 'assets'), path.join(app, 'assets'), { recursive: true });

const out = html
  .replace('<script type="module"', '<script src="./web-api.js"></script>\n    <script type="module"')
  .replace('</head>', '  <link rel="stylesheet" href="./web.css">\n  </head>');
if (!out.includes('web-api.js') || !out.includes('web.css')) throw new Error('index.html 형식이 바뀌어 web-api.js·web.css를 연결하지 못했습니다.');
await fs.writeFile(path.join(app, 'index.html'), out, 'utf8');
console.log('dist/app 갱신 완료');
