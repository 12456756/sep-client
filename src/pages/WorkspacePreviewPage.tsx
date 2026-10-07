import { useEffect, useState } from 'react';
import { Bell, Command, LayoutGrid, Moon, Network, Sun } from 'lucide-react';
import { AppSideNav } from '../components/enterprise/AppSideNav';
import { AppTopBar } from '../components/enterprise/AppTopBar';
import { CommandPalette } from '../components/enterprise/CommandPalette';
import { Empty } from '../components/enterprise/atoms';
import type { AppRoute } from '../features/enterprise/types';
import { OrganizationEmptyState } from './enterprise/OrganizationEmptyState';
import '../styles/enterprise.css';

/** Browser-only layout inspection. No fake account, platform data, IPC or task execution. */
export function WorkspacePreviewPage(): JSX.Element {
  const [route, setRoute] = useState<AppRoute>({ name: 'organization' });
  const [commandOpen, setCommandOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const isOrganization = route.name === 'organization';

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className={`ent-shell${darkMode ? ' dark' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`} data-theme={darkMode ? 'dark' : 'light'}>
      <AppSideNav
        enterpriseName="未连接平台"
        enterpriseMark="—"
        current={route.name}
        needsMeCount={0}
        canManage={false}
        userName="未登录"
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(prev => !prev)}
        onNavigate={setRoute}
        onOpenSettings={() => undefined}
        onLogout={() => setRoute({ name: 'home' })}
      />
      <div className="ent-shell-main">
        <AppTopBar
          title={isOrganization ? '组织架构' : '界面预览'}
          subtitle="浏览器仅预览界面，真实数据请在桌面客户端登录后查看"
          actions={(
            <div className="ent-top-actions-group">
              <div className="ent-view-switch" role="group" aria-label="页面切换">
                <button type="button" aria-pressed={!isOrganization} className={!isOrganization ? 'active' : undefined} onClick={() => setRoute({ name: 'home' })}>
                  <LayoutGrid size={14} aria-hidden />首页
                </button>
                <button type="button" aria-pressed={isOrganization} className={isOrganization ? 'active' : undefined} onClick={() => setRoute({ name: 'organization' })}>
                  <Network size={14} aria-hidden />组织架构
                </button>
              </div>
              <button type="button" className="ent-top-command" onClick={() => setCommandOpen(true)} title="打开命令入口（⌘K / Ctrl+K）" aria-label="打开命令入口">
                <Command size={14} aria-hidden />
                <span>⌘K</span>
              </button>
              <button type="button" className="ent-top-icon" onClick={() => setDarkMode(value => !value)} title={darkMode ? '切换到浅色主题' : '切换到深色主题'} aria-label={darkMode ? '切换到浅色主题' : '切换到深色主题'}>
                {darkMode ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
              </button>
              <button type="button" className="ent-top-icon" title="工作提醒，暂无待处理" aria-label="工作提醒，暂无待处理">
                <Bell size={16} aria-hidden />
              </button>
            </div>
          )}
        />
        <div className="ent-scroll">
          {isOrganization ? <OrganizationEmptyState /> : (
            <div className="ent-page preview-disconnected" role="status">
              <Empty title="尚未连接平台">
                请打开桌面客户端并登录，以获取真实的硅基员工、技能和工作记录。浏览器预览不提供任务运行功能。
              </Empty>
            </div>
          )}
        </div>
        {commandOpen ? (
          <CommandPalette
            darkMode={darkMode}
            onClose={() => setCommandOpen(false)}
            onNavigate={nextRoute => { setRoute(nextRoute); setCommandOpen(false); }}
            onToggleTheme={() => setDarkMode(value => !value)}
          />
        ) : null}
      </div>
    </div>
  );
}
