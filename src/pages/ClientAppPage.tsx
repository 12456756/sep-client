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

import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AppTopNav } from '../components/enterprise/AppTopNav';
import { useEnterpriseWorkspace } from '../features/enterprise/useEnterpriseWorkspace';
import type { EmployeeStatus, RuntimeInfo, Subscription } from '../shared/types';
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
  instances: Subscription[];
  employeeStatuses: EmployeeStatus[];
  onLogout: () => void | Promise<void>;
  /** 企业管理员才看到技能审核与员工权限入口。平台接口未开放，暂按 false。 */
  canManage?: boolean;
}

export function ClientAppPage({ userId, userName, enterpriseId, enterpriseName, instances, employeeStatuses, onLogout }: Props) {
  const workspace = useEnterpriseWorkspace({ userId, userName, enterpriseId, enterpriseName, instances, employeeStatuses });
  const { route, overview } = workspace;
  const scroll = useRef<HTMLDivElement | null>(null);
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);

  useEffect(() => {
    void window.electronAPI.getRuntimeInfo().then(result => {
      if (result.success && result.data) setRuntimeInfo(result.data);
    });
  }, []);

  // 换页就回到顶部。同一个滚动容器在页面之间复用，不重置的话新页面会从上一页的位置开始。
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [route]);

  return (
    <div className="ent-shell">
      <AppTopNav
        enterpriseName={overview.name}
        enterpriseMark={overview.mark}
        current={route.name}
        needsMeCount={overview.needsMeCount}
        userName={userName}
        onNavigate={workspace.navigate}
        onLogout={() => { void onLogout(); }}
      />
      <div className="ent-shell-main">
        {runtimeInfo ? (
          <div style={{ padding: '6px 24px', fontSize: 11, color: '#64748b', background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
            SEP Client {runtimeInfo.version} · {runtimeInfo.channel}/{runtimeInfo.environment} · API {runtimeInfo.apiBaseUrl} · 构建 {runtimeInfo.buildTime === 'development' ? '开发运行' : runtimeInfo.buildTime}
          </div>
        ) : null}
        {workspace.error ? (
          <div className="ent-error-bar" role="alert">
            <AlertTriangle size={14} aria-hidden />
            {workspace.error}
          </div>
        ) : null}
        <div className={`ent-scroll${(route.name === 'organization' || route.name === 'home') ? ' ent-scroll-no-overflow' : ''}`} ref={scroll}>
          <PageBody workspace={workspace} />
        </div>
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
