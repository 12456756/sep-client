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

import { AlertTriangle, Command, LayoutGrid, LoaderCircle, Moon, Network, RotateCw, Sun } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MediaPreferenceScopeContext } from '../components/workspace/media-preference-scope';
import { AppSideNav } from '../components/enterprise/AppSideNav';
import { ConversationSessionsContext, createConversationSessions } from '../features/enterprise/conversation-sessions';
import { AppTopBar } from '../components/enterprise/AppTopBar';
import { CommandPalette } from '../components/enterprise/CommandPalette';
import { NotificationCenter } from '../components/enterprise/NotificationCenter';
import { ProfileSettingsDialog } from '../components/enterprise/ProfileSettingsDialog';
import { useClientProfile } from '../features/enterprise/use-client-profile';
import { useRuntimeFeedback } from '../components/feedback/use-runtime-feedback';
import { displayedEnterpriseLogo, displayedUserAvatar } from '../features/enterprise/profile-display';
import { useEnterpriseWorkspace } from '../features/enterprise/useEnterpriseWorkspace';
import type { EmployeeLoadState } from '../features/enterprise/use-workspace-employees';
import type { EmployeeAvatarSource, EmployeeStatus, Subscription } from '../shared/types';
import { WorkHubPage } from './enterprise/WorkHubPage';
import { EmployeeDetailPage } from './enterprise/EmployeeDetailPage';
import { EmployeesPage } from './enterprise/EmployeesPage';
import { HomePageRedesign as HomePage } from './enterprise/HomePageRedesign';
import { SkillsPage } from './enterprise/SkillsPage';
import { ComputeCenterPage } from './enterprise/ComputeCenterPage';
import { OrganizationPage } from './enterprise/OrganizationPage';
import { KnowledgePage } from './enterprise/knowledge/KnowledgePage';
import '../styles/enterprise.css';
import '../styles/notifications.css';
import '../styles/updates.css';
import '../styles/arrange.css';
import '../styles/compute-center.css';

interface Props {
  userId: string;
  userName: string;
  enterpriseId: string;
  enterpriseName: string;
  userAvatar?: EmployeeAvatarSource | null;
  instances: Subscription[];
  employeeStatuses: EmployeeStatus[];
  employeeLoad?: EmployeeLoadState;
  employeeStatusLoad?: EmployeeLoadState;
  onLogout: () => void | Promise<void>;
  /** 企业管理员才看到技能审核与员工权限入口。平台接口未开放，暂按 false。 */
  canManage?: boolean;
}

export function ClientAppPage(props: Props) {
  return <MediaPreferenceScopeContext.Provider key={JSON.stringify([props.enterpriseId, props.userId])} value={{ enterpriseId: props.enterpriseId, memberId: props.userId }}>
    <ClientAppContent {...props} />
  </MediaPreferenceScopeContext.Provider>;
}

function ClientAppContent({ userId, userName, enterpriseId, enterpriseName, userAvatar: initialUserAvatar, instances, employeeStatuses, employeeLoad, employeeStatusLoad, onLogout, canManage = false }: Props) {
  useRuntimeFeedback(userId, enterpriseId);
  const workspace = useEnterpriseWorkspace({ userId, userName, enterpriseId, enterpriseName, instances, employeeStatuses });
  const [conversationSessions] = useState(() => createConversationSessions(sessionId => {
    void window.electronAPI.cancelAttachmentImport({ sessionId }).catch(() => undefined);
  }));
  useEffect(() => conversationSessions.retainOwner(), [conversationSessions]);
  const previousWorkIds = useRef(new Set<string>());
  useEffect(() => {
    const currentIds = new Set(workspace.works.map(work => work.id));
    for (const id of previousWorkIds.current) if (!currentIds.has(id)) conversationSessions.remove(id);
    previousWorkIds.current = currentIds;
  }, [workspace.works, conversationSessions]);
  const profileWorkspace = useClientProfile();
  const { route, overview } = workspace;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const profile = profileWorkspace.profile;
  const userAvatar = displayedUserAvatar(profile, initialUserAvatar ?? null, userName);
  const displayUserName = profile?.user.name || userName;
  const displayEnterpriseName = profile ? profile.enterprise?.name || overview.name : overview.name;
  const displayEnterpriseLogo = displayedEnterpriseLogo(profile, overview.logo);
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
      case 'arrange': return null;
      case 'employees': return { title: '硅基员工', breadcrumb: ['个人'], subtitle: `企业共 ${overview.totalEmployees} 位，其中 ${overview.availableToMe} 位已分配给你` };
      case 'employee': {
        const employee = workspace.employees.find(item => item.id === route.employeeId);
        return { title: employee?.name ?? '员工详情', breadcrumb: ['个人', '硅基员工'] };
      }
      case 'records': return null;
      case 'skills': return { title: '员工技能', breadcrumb: ['个人'], subtitle: '查看技能原文、管理个人版本，选择员工使用的技能版本' };
      case 'knowledge': return { title: '知识库', breadcrumb: ['企业'], subtitle: '企业资料、文档版本与成员访问权限' };
      case 'compute-center': return { title: '算力中心', subtitle: '企业额度、个人钱包与消费情况' };
      default: return { title: overview.name };
    }
  }, [route, overview, workspace.employees]);

  return (
    <div className={`ent-shell${darkMode ? ' dark' : ''} sidebar-collapsed${['arrange', 'records', 'work'].includes(route.name) ? ' ent-work-shell' : ''}`} data-theme={darkMode ? 'dark' : 'light'}>
      <AppSideNav
        enterpriseName={displayEnterpriseName}
        enterpriseMark={displayEnterpriseName.slice(0, 1) || overview.mark}
        enterpriseLogo={displayEnterpriseLogo}
        current={route.name}
        needsMeCount={overview.needsMeCount}
        canManage={canManage}
        userName={displayUserName}
        userAvatar={userAvatar}
        collapsed
        onNavigate={workspace.navigate}
        onOpenSettings={() => setSettingsOpen(true)}
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
              <NotificationCenter onOpenAction={async notification => {
                if (notification.category === 'USAGE_ALERT' || notification.type === 'CONTRIBUTION_REWARD_CREDITED') {
                  workspace.navigate({ name: 'compute-center' });
                } else if (notification.type === 'SKILL_VERSION_UPDATED') {
                  workspace.navigate({ name: 'skills' });
                } else if (notification.actionUrl) {
                  // Desktop does not implement platform approval/contribution pages.
                  // Main validates the trusted Web origin before opening the browser.
                  const result = await window.electronAPI.openNotificationAction(notification.actionUrl);
                  if (!result.success) throw new Error(result.error?.message || '无法打开通知关联页面');
                }
              }} />
            </div>
          )}
        />
        <EmployeeLoadNotice state={employeeLoad} loadingLabel="正在加载员工列表" retryLabel="重试加载员工列表" />
        <EmployeeLoadNotice state={employeeStatusLoad} loadingLabel="正在加载员工状态" retryLabel="重试加载员工状态" />
        {workspace.error ? (
          <div className="ent-error-bar" role="alert">
            <AlertTriangle size={14} aria-hidden />
            {workspace.error}
          </div>
        ) : null}
        <div
          className={`ent-scroll${(route.name === 'organization' || route.name === 'home') ? ' ent-scroll-no-overflow' : ''}${['arrange', 'records', 'work'].includes(route.name) ? ' ent-scroll-work' : ''}`}
          ref={scroll}
        >
          <ConversationSessionsContext.Provider value={conversationSessions}>
            <PageBody workspace={workspace} />
          </ConversationSessionsContext.Provider>
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
      {settingsOpen ? (
        <ProfileSettingsDialog
          profile={profile}
          userName={userName}
          canManage={canManage}
          uploading={profileWorkspace.uploading}
          error={profileWorkspace.error}
          onUploadAvatar={async input => {
            const result = await profileWorkspace.uploadAvatar(input);
            await workspace.refreshOrganization();
            return result;
          }}
          onUploadLogo={async input => {
            const result = await profileWorkspace.uploadLogo(input);
            await workspace.refreshOrganization();
            return result;
          }}
          onRefresh={async () => {
            const result = await profileWorkspace.refresh();
            await workspace.refreshOrganization();
            return result;
          }}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </div>
  );
}

function EmployeeLoadNotice({ state, loadingLabel, retryLabel }: { state?: EmployeeLoadState; loadingLabel: string; retryLabel: string }) {
  if (state?.error) return (
    <div className="ent-load-bar">
      <button type="button" className="ent-top-icon ent-load-retry" aria-label={retryLabel} title={retryLabel} disabled={state.loading} onClick={state.retry}>
        <RotateCw size={15} aria-hidden />
        <span>{retryLabel}</span>
      </button>
    </div>
  );
  if (!state?.loading) return null;
  return <div className="ent-load-bar" role="status"><LoaderCircle size={14} aria-hidden /><span>{loadingLabel}</span></div>;
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
    case 'records':
    case 'work':
      return <WorkHubPage key={workspace.attachmentScopeKey} workspace={workspace} />;
    case 'skills':
      return <SkillsPage workspace={workspace} skillId={route.skillId} />;
    case 'compute-center':
      return <ComputeCenterPage />;
    case 'knowledge':
      return <KnowledgePage kbId={route.kbId} navigate={workspace.navigate} />;
    default:
      return <HomePage workspace={workspace} />;
  }
}
