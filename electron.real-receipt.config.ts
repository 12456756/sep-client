import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Explicit acceptance build; never imports the release config or generates runtime configuration.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'out/real-receipt/main', rollupOptions: {
      input: { index: resolve(__dirname, 'scripts/electron-real-receipt-main.ts') },
    } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'out/real-receipt/preload', rollupOptions: {
      input: { index: resolve(__dirname, 'electron/preload.ts') },
      output: { format: 'cjs', entryFileNames: '[name].cjs' },
    } },
  },
  renderer: {
    root: resolve(__dirname, 'src/real-receipt-harness'),
    plugins: [react()],
    build: { outDir: resolve(__dirname, 'out/real-receipt/renderer'),
      rollupOptions: { input: resolve(__dirname, 'src/real-receipt-harness/index.html') } },
  },
})
