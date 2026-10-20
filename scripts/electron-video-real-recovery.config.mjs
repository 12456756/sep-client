import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

// Explicit isolated build; never imported by a production entry point.
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { outDir: 'out/video-real-recovery/main',
    rollupOptions: { input: resolve('scripts/electron-video-real-recovery-main.ts'), output: { entryFileNames: 'index.mjs' } } } },
  preload: { plugins: [externalizeDepsPlugin()], build: { outDir: 'out/video-real-recovery/preload',
    rollupOptions: { input: resolve('electron/preload.ts'), output: { entryFileNames: 'index.mjs' } } } },
  renderer: { root: resolve('scripts/electron-video-real-recovery-renderer'), base: './', plugins: [react(), tailwindcss()],
    build: { outDir: resolve('out/video-real-recovery/renderer'), emptyOutDir: true,
      rollupOptions: { input: resolve('scripts/electron-video-real-recovery-renderer/index.html') } } },
})
