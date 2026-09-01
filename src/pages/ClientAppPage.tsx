/**
 * 客户端应用外壳：侧边导航 + 顶栏 + 当前页面。
 *
 * 所有页面数据来自 useEnterpriseWorkspace，页面组件不直接调用 window.electronAPI。
 * 路由用受控状态而不是 URL，因为桌面端不需要地址栏，返回行为由 hook 维护的历史栈决定。
 */

import { AlertTriangle, X } from 'lucide-react';
import { useMemo } from 'react';
import { AppSidebar } from '../components/enterprise/AppSidebar';
import { AppTopBar } from '../components/enterprise/AppTopBar';
import { useEnterpriseWorkspace } from '../features/enterprise/useEnterpriseWorkspace';
import type { EmployeeInstanceSnapshot } from '../shared/types';
import { ArrangeWorkPage } from './enterprise/ArrangeWorkPage';
import { EmployeeDetailPage } from './enterprise/EmployeeDetailPage';
import { EmployeesPage } from './enterprise/EmployeesPage';
import { HomePage } from './enterprise/HomePage';
import { SkillsPage } from './enterprise/SkillsPage';
import { WorkConversationPage } from './enterprise/WorkConversationPage';
import { WorkRecordsPage } from './enterprise/WorkRecordsPage';
import '../styles/enterprise.css';

interface Props {
  userName: string;
  enterpriseId: string;
  enterpriseName: string;
  instances: EmployeeInstanceSnapshot[];
  onLogout: () => void | Promise<void>;
  /** 企业管理员才看到技能审核与员工权限入口。平台接口未开放，暂按 false。 */
  canManage?: boolean;
}

export function ClientAppPage({ userName, enterpriseId, enterpriseName, instances, onLogout, canManage = false }: Props) {
  const workspace = useEnterpriseWorkspace({ userName, enterpriseId, enterpriseName, instances });
  const { route, overview } = workspace;

  /** 顶栏只显示「我在哪」，一行，不带说明文字。搜索由需要它的页面自己提供。 */
  const title = useMemo(() => {
    switch (route.name) {
      case 'home': return '工作台';
      case 'employees': return '硅基员工';
      case 'employee': return '员工详情';
      case 'arrange': return '安排工作';
      case 'records': return '工作记录';
      case 'work': return '工作详情';
      case 'skills': return '员工技能';
      default: return overview.name;
    }
  }, [route.name, overview.name]);

  return (
    <div className="ent-shell">
      <AppSidebar
        enterpriseName={overview.name}
        enterpriseMark={overview.mark}
        current={route.name}
        needsMeCount={overview.needsMeCount}
        canManage={canManage}
        userName={userName}
        onNavigate={workspace.navigate}
        onLogout={() => { void onLogout(); }}
      />
      <div className="ent-shell-main">
        <AppTopBar
          title={title}
          needsMeCount={overview.needsMeCount}
          onOpenReminders={() => workspace.navigate({ name: 'records' })}
        />
        {workspace.error ? (
          <div className="ent-error-bar" role="alert">
            <AlertTriangle size={14} aria-hidden />
            {workspace.error}
            <button type="button" className="ent-banner-close" onClick={workspace.dismissError} aria-label="关闭提示">
              <X size={14} aria-hidden />
            </button>
          </div>
        ) : null}
        <div className="ent-scroll">
          <PageBody workspace={workspace} />
        </div>
      </div>
    </div>
  );
}

function PageBody({ workspace }: { workspace: ReturnType<typeof useEnterpriseWorkspace> }) {
  const { route } = workspace;
  switch (route.name) {
    case 'employees':
      // key 带上 scope：从首页两个指标格分别进来时要重置默认范围，否则组件不会重新初始化。
      return <EmployeesPage key={route.scope ?? 'mine'} workspace={workspace} scope={route.scope} />;
    case 'employee':
      return <EmployeeDetailPage workspace={workspace} employeeId={route.employeeId} />;
    case 'arrange':
      return <ArrangeWorkPage workspace={workspace} templateId={route.templateId} custom={route.custom ?? false} />;
    case 'records':
      return <WorkRecordsPage workspace={workspace} />;
    case 'work':
      return <WorkConversationPage workspace={workspace} workId={route.workId} />;
    case 'skills':
      return <SkillsPage workspace={workspace} skillId={route.skillId} />;
    default:
      return <HomePage workspace={workspace} />;
  }
}
