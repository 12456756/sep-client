/**
 * 顶栏：只剩当前位置和待处理提醒。
 *
 * 返回、搜索、账号都已经移走（返回改为页内返回、搜索下沉到各自页面、账号在侧栏底部），
 * 顶栏保留的原因是它承担 Electron 的窗口拖拽区（electron-drag-region）。
 * 顶栏不出现任何技术标识（任务 ID、会话、模型名）。
 */

import { Bell } from 'lucide-react';

interface Props {
  title: string;
  /** 待我确认或需要重试的工作数量。 */
  needsMeCount: number;
  onOpenReminders: () => void;
}

export function AppTopBar({ title, needsMeCount, onOpenReminders }: Props) {
  return (
    <header className="ent-top electron-drag-region">
      <div className="ent-top-title">{title}</div>
      <button
        type="button"
        className="ent-top-icon"
        onClick={onOpenReminders}
        title={needsMeCount ? `${needsMeCount} 项工作等你处理` : '暂无待处理的工作'}
        aria-label={needsMeCount ? `${needsMeCount} 项工作等你处理` : '暂无待处理的工作'}
      >
        <Bell size={16} aria-hidden />
        {needsMeCount ? <span className="ent-dot" /> : null}
      </button>
    </header>
  );
}
