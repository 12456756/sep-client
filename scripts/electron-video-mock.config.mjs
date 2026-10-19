import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

// Opt-in fixture build; neither this entry nor its renderer enters production builds.
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { outDir: 'out-video-mock/main', rollupOptions: {
    input: { index: resolve('scripts/electron-video-mock-main.ts'), fixture: resolve('scripts/video-mock-fixture-server.ts') }, external: ['ws'],
    output: { entryFileNames: '[name].mjs' },
  } } },
  preload: { plugins: [externalizeDepsPlugin()], build: { outDir: 'out-video-mock/preload', rollupOptions: {
    input: { index: resolve('electron/preload.ts') },
  } } },
  renderer: { root: resolve('scripts/video-mock'), plugins: [react(), tailwindcss()], base: './',
    build: { outDir: resolve('out-video-mock/renderer'), emptyOutDir: true, rollupOptions: { input: resolve('scripts/video-mock/index.html') } },
  },
})
