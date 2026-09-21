/**
 * src/main.tsx — React 渲染进程入口
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { WorkspacePreviewPage } from './pages/WorkspacePreviewPage';
import { ErrorBoundary } from './components/ErrorBoundary';
import { initPerformanceMonitoring } from './utils/performance-monitor';
import { initImageFormatSupport } from './utils/image-optimization';
import './index.css';

// 初始化性能监控
initPerformanceMonitoring();

// 初始化图片格式支持检测
initImageFormatSupport();

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

const previewRequested = import.meta.env.DEV && new URLSearchParams(window.location.search).get('preview') === 'workspace';

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      {previewRequested ? <WorkspacePreviewPage /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);
