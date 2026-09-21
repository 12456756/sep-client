import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts'),
        },
      },
    },
  },
  renderer: {
    plugins: [
      react(),
      tailwindcss(),
      // Bundle 分析工具（仅在构建时生成）
      visualizer({
        filename: 'bundle-analysis.html',
        open: false, // 手动打开
        gzipSize: true,
        brotliSize: true,
        template: 'treemap', // 可选: 'sunburst', 'treemap', 'network'
      }) as any,
    ],
    root: resolve(__dirname, 'src'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    // Web Worker 支持
    worker: {
      format: 'es',
      plugins: () => [react()],
      rollupOptions: {
        output: {
          entryFileNames: 'workers/[name].[hash].js',
        },
      },
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/index.html'),
        output: {
          manualChunks: {
            // React 核心库
            'react-vendor': ['react', 'react-dom'],
            // UI 组件库
            'ui-vendor': [
              '@radix-ui/react-dialog',
              '@radix-ui/react-scroll-area',
              '@radix-ui/react-separator',
              '@radix-ui/react-toast',
              '@radix-ui/react-tooltip',
            ],
            // 可视化库
            'flow-vendor': ['@xyflow/react'],
            // 路由和状态管理
            'state-vendor': ['react-router-dom', 'zustand'],
            // 图标库
            'icon-vendor': ['lucide-react'],
          },
        },
      },
      // 压缩优化
      minify: 'esbuild',
      // 启用 CSS 代码分割
      cssCodeSplit: true,
      // 提高 chunk 大小警告阈值
      chunkSizeWarningLimit: 1000,
    },
    // 依赖预构建优化
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'zustand',
        'react-router-dom',
      ],
    },
  },
});
