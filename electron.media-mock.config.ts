import { resolve } from 'node:path'
import { mergeConfig } from 'vite'
import standard from './electron.vite.config'

// Opt-in test build. The normal release config never includes the mock entry.
export default mergeConfig(standard, {
  main: { build: { rollupOptions: { output: { chunkFileNames: '[name]-[hash].js' }, input: {
    'media-mock': resolve(__dirname, 'scripts/electron-media-mock-main.ts'),
  } } } },
})
