import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // 모든 의존성을 main 번들에 포함 → 설치본에 node_modules가 필요 없음
    build: {
      externalizeDeps: false,
      rollupOptions: {
        // ws(@google/genai 의존성)의 선택적 네이티브 가속 모듈. 없으면 ws가 알아서 건너뛴다.
        external: ['bufferutil', 'utf-8-validate']
      }
    },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [react()]
  }
})
