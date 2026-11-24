import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { readBundledRelease } from './scripts/bundled-release';

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  define: { __SEP_CURRENT_RELEASE__: JSON.stringify(readBundledRelease(projectRoot)) },
  root: resolve(projectRoot, 'src'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src'),
      '@shared': resolve(projectRoot, 'src/shared'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
});
