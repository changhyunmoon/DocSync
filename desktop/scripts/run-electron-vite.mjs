// Windows에서 `npm run`이 붙이는 환경 변수 때문에 electron-vite가 Electron을 띄울 때
// "spawn UNKNOWN"이 나는 경우가 있어, npm 환경 변수를 정리한 뒤 electron-vite를 실행한다.
// (Windows는 환경 블록 전체 크기에 제한이 있어 PATH가 길면 프로세스 생성이 실패한다)
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js')

const env = {}
for (const [k, v] of Object.entries(process.env)) {
  if (/^npm_/i.test(k)) continue
  env[k] = v
}
const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path')
if (pathKey) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const seen = new Set()
  env[pathKey] = env[pathKey]
    .split(sep)
    .filter((p) => {
      const key = p.trim().replace(/[\\/]+$/, '').toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join(sep)
}

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 0))
