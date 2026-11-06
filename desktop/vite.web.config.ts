import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = dirname(fileURLToPath(import.meta.url))

// Build only the browser renderer. Electron main/preload and installers are not built.
export default defineConfig({
  root: resolve(here, 'src/renderer'),
  base: './',
  resolve: { alias: { '@shared': resolve(here, 'src/shared') } },
  plugins: [react()],
  build: {
    outDir: resolve(here, '../.web-build/renderer'),
    emptyOutDir: true
  }
})
