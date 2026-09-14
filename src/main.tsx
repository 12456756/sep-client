/**
 * src/main.tsx — React 渲染进程入口
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { WorkspacePreviewPage } from './pages/WorkspacePreviewPage';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

const previewRequested = import.meta.env.DEV && new URLSearchParams(window.location.search).get('preview') === 'workspace';

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {previewRequested ? <WorkspacePreviewPage /> : <App />}
  </React.StrictMode>,
);


