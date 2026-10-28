/**
 * 全局工具栏只展示右侧操作，页面位置由侧栏选中状态表达。
 * 同时保留 Electron 拖拽区和 Windows 窗口按钮的安全空间。
 */

import type { ReactNode } from 'react';

interface Props {
  /** 全局操作，靠右对齐。 */
  actions?: ReactNode;
}

export function AppTopBar({ actions }: Props) {
  return (
    <header className="ent-top electron-drag-region">
      {actions ? <div className="ent-top-actions">{actions}</div> : null}
    </header>
  );
}
