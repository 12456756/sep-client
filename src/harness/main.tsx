/**
 * 截图脚手架入口。生产入口 src/main.tsx 不引用本文件。
 *
 * 做两件事：
 * 1. 在 React 渲染前，把内存版 mock 装到 window.electronAPI（渲染层只认这个全局）。
 * 2. 用 fixtures 里的身份与订阅数据渲染真实的 <ClientAppPage>。
 *
 * 之后由 scripts/harness-screenshot.mjs 用 Playwright 点击侧边栏/卡片逐个页面截图。
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClientAppPage } from '../pages/ClientAppPage';
import { mockElectronAPI } from './mock-electron-api';
import { EMPLOYEE_STATUSES, SESSION, SUBSCRIPTIONS } from './fixtures';
import '../index.css';

// 必须在任何渲染层代码读取 window.electronAPI 之前装好。
Object.defineProperty(window, 'electronAPI', {
  value: mockElectronAPI,
  configurable: true,
  writable: true,
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ClientAppPage
      userId={SESSION.userId}
      userName={SESSION.userName}
      enterpriseId={SESSION.enterpriseId}
      enterpriseName={SESSION.enterpriseName}
      instances={SUBSCRIPTIONS}
      employeeStatuses={EMPLOYEE_STATUSES}
      onLogout={() => {}}
      canManage={false}
    />
  </React.StrictMode>,
);
