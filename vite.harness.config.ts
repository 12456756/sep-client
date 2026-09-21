/**
 * 截图脚手架专用 vite 配置。不进入 npm run build / dev，只被
 * scripts/harness-screenshot.mjs 临时拉起，用来在无平台凭据时把真实页面渲染出来截图。
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
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
    port: 5199,
    strictPort: true,
  },
});
