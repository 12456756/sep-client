/**
 * 全局工具栏左侧控制侧栏，右侧展示全局操作。
 * 同时保留 Electron 拖拽区和 Windows 窗口按钮的安全空间。
 */

import type { ReactNode } from 'react';
import { PanelLeft } from 'lucide-react';
import { IconHint } from './IconHint';

interface Props {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /** 全局操作，靠右对齐。 */
  actions?: ReactNode;
}

export function AppTopBar({ actions, sidebarCollapsed, onToggleSidebar }: Props) {
  return (
    <header className="ent-top electron-drag-region">
      <IconHint label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} side="bottom">
        <button type="button" className="ent-top-sidebar-toggle" aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} aria-expanded={!sidebarCollapsed} aria-controls="ent-primary-navigation" onClick={onToggleSidebar}>
          <PanelLeft size={20} strokeWidth={1.8} aria-hidden />
        </button>
      </IconHint>
      {actions ? <div className="ent-top-actions">{actions}</div> : null}
    </header>
  );
}
