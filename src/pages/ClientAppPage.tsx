/**
 * 客户端应用外壳：左侧导航 + 顶部 Header + 当前页面。
 *
 * 导航永远在左边、通高，不会因为窗口变窄跑到顶部。右边是内容区，内容区顶部那条
 * 白色 Header（AppTopBar）左边写当前页面的名字、右边挂一颗铃铛，同时给 Electron
 * 当窗口拖拽区，并把 Windows 的窗口按钮（titleBarOverlay 画在右上角）让开。
 *
 * 所有页面数据来自 useEnterpriseWorkspace，页面组件不直接调用 window.electronAPI。
 * 路由用受控状态而不是 URL，因为桌面端不需要地址栏，返回行为由 hook 维护的历史栈决定。
 */

import { AlertTriangle, Bell, Command, LayoutGrid, Moon, Network, Sun } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppSideNav } from '../components/enterprise/AppSideNav';
import { AppTopBar } from '../components/enterprise/AppTopBar';
import { CommandPalette } from '../components/enterprise/CommandPalette';
import { useEnterpriseWorkspace } from '../features/enterprise/useEnterpriseWorkspace';
import type { EmployeeAvatarSource, EmployeeStatus, Subscription } from '../shared/types';
import { ArrangeWorkPage } from './enterprise/ArrangeWorkPage';
import { EmployeeDetailPage } from './enterprise/EmployeeDetailPage';
import { EmployeesPage } from './enterprise/EmployeesPage';
import { HomePage } from './enterprise/HomePage';
import { SkillsPage } from './enterprise/SkillsPage';
import { WorkDetailPage } from './enterprise/WorkDetailPage';
import { WorkRecordsPage } from './enterprise/WorkRecordsPage';
import { OrganizationPage } from './enterprise/OrganizationPage';
import '../styles/enterprise.css';
import '../styles/arrange.css';

interface Props {
  userId: string;
  userName: string;
  enterpriseId: string;
  enterpriseName: string;
  userAvatar?: EmployeeAvatarSource | null;
  instances: Subscription[];
  employeeStatuses: EmployeeStatus[];
  onLogout: () => void | Promise<void>;
  /** 企业管理员才看到技能审核与员工权限入口。平台接口未开放，暂按 false。 */
  canManage?: boolean;
}

export function ClientAppPage({ userId, userName, enterpriseId, enterpriseName, userAvatar: initialUserAvatar, instances, employeeStatuses, onLogout, canManage = false }: Props) {
  const workspace = useEnterpriseWorkspace({ userId, userName, enterpriseId, enterpriseName, instances, employeeStatuses });
  const { route, overview } = workspace;
  const userAvatar = workspace.currentUserAvatar ?? initialUserAvatar ?? null;
  const scroll = useRef<HTMLDivElement | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => {
    try { return window.localStorage.getItem('sep.theme') === 'dark'; } catch { return false; }
  });

  useEffect(() => {
    try { window.localStorage.setItem('sep.theme', darkMode ? 'dark' : 'light'); } catch { /* 无痕模式不阻断主题切换。 */ }
  }, [darkMode]);
  useEffect(() => {
    void window.electronAPI.setWindowTheme(darkMode ? 'dark' : 'light');
  }, [darkMode]);
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

  // 换页就回到顶部。同一个滚动容器在页面之间复用，不重置的话新页面会从上一页的位置开始。
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [route]);

  // 页面标题、层级路径和副标题统一放在顶部标题栏；工作详情保留自身标题。
  const head = useMemo<{ title: string; breadcrumb?: readonly string[]; subtitle?: string } | null>(() => {
    switch (route.name) {
      case 'organization': return { title: '企业组织', breadcrumb: ['企业'], subtitle: `${overview.name} · 企业成员与硅基员工关系` };
      case 'home': return null;
      case 'work': return null;
      case 'arrange': return { title: '安排工作', breadcrumb: ['个人', '安排工作'] };
      case 'employees': return { title: '硅基员工', breadcrumb: ['个人'], subtitle: `企业共 ${overview.totalEmployees} 位，其中 ${overview.availableToMe} 位已分配给你` };
      case 'employee': {
        const employee = workspace.employees.find(item => item.id === route.employeeId);
        return { title: employee?.name ?? '员工详情', breadcrumb: ['个人', '硅基员工'] };
      }
      case 'records': return { title: '工作记录', breadcrumb: ['个人'], subtitle: '优先展示需要你处理的工作' };
      case 'skills': return { title: '员工技能', breadcrumb: ['个人'], subtitle: '查看技能原文、管理个人版本，选择员工使用的技能版本' };
      default: return { title: overview.name };
    }
  }, [route, overview, workspace.employees]);

  return (
    <div className={`ent-shell${darkMode ? ' dark' : ''}`} data-theme={darkMode ? 'dark' : 'light'}>
      <AppSideNav
        enterpriseName={overview.name}
        enterpriseMark={overview.mark}
        enterpriseLogo={overview.logo}
        current={route.name}
        needsMeCount={overview.needsMeCount}
        canManage={canManage}
        userName={userName}
        userAvatar={userAvatar}
        onNavigate={workspace.navigate}
        onLogout={() => { void onLogout(); }}
      />
      <div className="ent-shell-main">
        <AppTopBar
          title={head?.title}
          breadcrumb={head?.breadcrumb}
          subtitle={head?.subtitle}
          actions={(
            <div className="ent-top-actions-group">
              <div className="ent-view-switch" role="group" aria-label="页面切换">
                <button
                  type="button"
                  className={route.name === 'organization' ? undefined : 'active'}
                  onClick={() => workspace.navigate({ name: 'home' })}
                  aria-pressed={route.name !== 'organization'}
                  title="切换到个人工作台"
                >
                  <LayoutGrid size={14} aria-hidden />
                  个人
                </button>
                <button
                  type="button"
                  className={route.name === 'organization' ? 'active' : undefined}
                  onClick={() => workspace.navigate({ name: 'organization' })}
                  aria-pressed={route.name === 'organization'}
                  title="切换到企业组织"
                >
                  <Network size={14} aria-hidden />
                  企业
                </button>
              </div>
              <button
                type="button"
                className="ent-top-command"
                onClick={() => setCommandOpen(true)}
                title="打开命令入口（⌘K / Ctrl+K）"
                aria-label="打开命令入口"
              >
                <Command size={14} aria-hidden />
                <span>⌘K</span>
              </button>
              <button
                type="button"
                className="ent-top-icon"
                onClick={() => setDarkMode(value => !value)}
                title={darkMode ? '切换到浅色主题' : '切换到深色主题'}
                aria-label={darkMode ? '切换到浅色主题' : '切换到深色主题'}
              >
                {darkMode ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
              </button>
              <button
                type="button"
                className="ent-top-icon"
                onClick={() => workspace.navigate({ name: 'records', bucket: overview.needsMeCount ? 'mine' : 'all' })}
                title={overview.needsMeCount ? `${overview.needsMeCount} 项工作等你处理` : '工作记录'}
                aria-label={overview.needsMeCount ? `工作提醒，${overview.needsMeCount} 项等你处理` : '工作提醒，暂无待处理'}
              >
                <Bell size={16} aria-hidden />
                {overview.needsMeCount ? <span className="ent-dot" aria-hidden /> : null}
              </button>
            </div>
          )}
        />
        {workspace.error ? (
          <div className="ent-error-bar" role="alert">
            <AlertTriangle size={14} aria-hidden />
            {workspace.error}
          </div>
        ) : null}
        <div
          className={`ent-scroll${(route.name === 'organization' || route.name === 'home') ? ' ent-scroll-no-overflow' : ''}${route.name === 'arrange' ? ' ent-scroll-arrange' : ''}`}
          ref={scroll}
        >
          <PageBody workspace={workspace} />
        </div>
        {commandOpen ? (
          <CommandPalette
            darkMode={darkMode}
            onClose={() => setCommandOpen(false)}
            onNavigate={routeToOpen => { workspace.navigate(routeToOpen); setCommandOpen(false); }}
            onToggleTheme={() => setDarkMode(value => !value)}
          />
        ) : null}
      </div>
    </div>
  );
}

function PageBody({ workspace }: { workspace: ReturnType<typeof useEnterpriseWorkspace> }) {
  const { route } = workspace;
  switch (route.name) {
    case 'organization':
      return (
        <OrganizationPage
          workspace={{ employees: workspace.organizationEmployees, navigate: workspace.navigate }}
          members={workspace.organizationMembers}
          organizationStatus={workspace.organizationStatus}
          organizationError={workspace.organizationError}
          onRetry={workspace.retryOrganization}
        />
      );
    case 'employees':
      // key 带上 scope：从首页两个指标格分别进来时要重置默认范围，否则组件不会重新初始化。
      return <EmployeesPage key={route.scope ?? 'mine'} workspace={workspace} scope={route.scope} />;
    case 'employee':
      return <EmployeeDetailPage workspace={workspace} employeeId={route.employeeId} />;
    case 'arrange':
      return <ArrangeWorkPage workspace={workspace} templateId={route.templateId} employeeId={route.employeeId} mode={route.mode ?? 'pick'} />;
    case 'records':
      return <WorkRecordsPage workspace={workspace} />;
    case 'work':
      return <WorkDetailPage workspace={workspace} workId={route.workId} />;
    case 'skills':
      return <SkillsPage workspace={workspace} skillId={route.skillId} />;
    default:
      return <HomePage workspace={workspace} />;
  }
}
