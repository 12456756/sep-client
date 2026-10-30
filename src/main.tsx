/**
 * src/main.tsx — React 渲染进程入口
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { WorkspacePreviewPage } from './pages/WorkspacePreviewPage';
import './index.css';

const root = document.getElementById('root');
const runtime = window.electronAPI;
if (runtime) {
  document.documentElement.dataset.platform = runtime.platform;
  document.documentElement.style.setProperty('--window-chrome-height', `${runtime.windowChrome.height}px`);
  document.documentElement.style.setProperty('--window-controls-inset', `${runtime.windowChrome.rightInset}px`);
}
if (!root) throw new Error('Root element not found');

const preview = import.meta.env.DEV ? new URLSearchParams(window.location.search).get('preview') : null;
const previewRequested = preview === 'workspace';
const HomePreviewPage = preview === 'home'
  ? React.lazy(() => import('./pages/HomePreviewPage').then(module => ({ default: module.HomePreviewPage })))
  : null;

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {previewRequested ? <WorkspacePreviewPage /> : HomePreviewPage ? (
      <React.Suspense fallback={null}><HomePreviewPage /></React.Suspense>
    ) : <App />}
  </React.StrictMode>,
);
