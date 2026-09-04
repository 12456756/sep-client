/**
 * 客户端应用外壳：左侧导航 + 顶部 Header + 当前页面。
 *
 * 导航永远在左边、通高，不会因为窗口变窄跑到顶部。右边是内容区，内容区顶部那条
 * 白色 Header（AppTopBar）既写当前页面的名字，也给 Electron 当窗口拖拽区，
 * 同时把 Windows 的窗口按钮（titleBarOverlay 画在右上角）让开。
 *
 * 所有页面数据来自 useEnterpriseWorkspace，页面组件不直接调用 window.electronAPI。
 * 路由用受控状态而不是 URL，因为桌面端不需要地址栏，返回行为由 hook 维护的历史栈决定。
 */

import { AlertTriangle, X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { AppSideNav } from '../components/enterprise/AppSideNav';
import { AppTopBar } from '../components/enterprise/AppTopBar';
import { useEnterpriseWorkspace } from '../features/enterprise/useEnterpriseWorkspace';
import type { EmployeeInstanceSnapshot } from '../shared/types';
import { ArrangeWorkPage } from './enterprise/ArrangeWorkPage';
import { EmployeeDetailPage } from './enterprise/EmployeeDetailPage';
import { EmployeesPage } from './enterprise/EmployeesPage';
import { HomePage } from './enterprise/HomePage';
import { SkillsPage } from './enterprise/SkillsPage';
import { WorkDetailPage } from './enterprise/WorkDetailPage';
import { WorkRecordsPage } from './enterprise/WorkRecordsPage';
import '../styles/enterprise.css';
import '../styles/arrange.css';

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
  const scroll = useRef<HTMLDivElement | null>(null);

  // 换页就回到顶部。同一个滚动容器在页面之间复用，不重置的话新页面会从上一页的位置开始。
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [route]);

  /**
   * 页面抬头「我在哪」。四个例外：
   * - 首页和工作详情页不要抬头：它们自己的第一行就是内容（数字格 / 工作名 + 状态），
   *   再写一句栏目名只是重复导航栏已经点亮的入口。
   * - 员工详情页那一行直接写主角的名字，不写「员工详情」这类栏目名 ——
   *   否则页面里还得再写一遍标题，同一个名字出现两次。
   * - 安排工作自己写标题：四个画面各有各的抬头（安排工作 / 对话式 / 自动编排 / 自己编排），
   *   外面再套一个固定的「安排工作」会和它打架。
   */
  const head = useMemo<{ title: string; subtitle?: string } | null>(() => {
    switch (route.name) {
      case 'home': return null;
      case 'work': return null;
      case 'arrange': return null;
      case 'employees': return { title: '硅基员工', subtitle: `企业共 ${overview.totalEmployees} 位，其中 ${overview.availableToMe} 位已分配给你` };
      case 'employee': {
        const employee = workspace.employees.find(item => item.id === route.employeeId);
        return { title: employee?.name ?? '员工详情' };
      }
      case 'records': return { title: '工作记录' };
      case 'skills': return { title: '员工技能', subtitle: '技能决定员工怎么做事。企业标准只读，你可以在它之上建立自己的版本' };
      default: return { title: overview.name };
    }
  }, [route, overview, workspace.employees]);

  return (
    <div className="ent-shell">
      <AppSideNav
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
        <AppTopBar title={head?.title} subtitle={head?.subtitle} />
        {workspace.error ? (
          <div className="ent-error-bar" role="alert">
            <AlertTriangle size={14} aria-hidden />
            {workspace.error}
            <button type="button" className="ent-banner-close" onClick={workspace.dismissError} aria-label="关闭提示">
              <X size={14} aria-hidden />
            </button>
          </div>
        ) : null}
        <div className="ent-scroll" ref={scroll}>
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
