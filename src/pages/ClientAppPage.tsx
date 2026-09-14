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

import { AlertTriangle, Bell, X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { AppSideNav } from '../components/enterprise/AppSideNav';
import { AppTopBar } from '../components/enterprise/AppTopBar';
import { useEnterpriseWorkspace } from '../features/enterprise/useEnterpriseWorkspace';
import type { Subscription } from '../shared/types';
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
  instances: Subscription[];
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
   * 页面抬头「我在哪」。三个例外：
   * - 工作详情页和安排工作页不要抬头：它们自己的第一行就是内容（工作名 + 状态 /
   *   四个画面各自的抬头），外面再套一句栏目名会和它打架。
   * - 员工详情页那一行直接写主角的名字，不写「员工详情」这类栏目名 ——
   *   否则页面里还得再写一遍标题，同一个名字出现两次。
   */
  const head = useMemo<{ title: string; subtitle?: string } | null>(() => {
    switch (route.name) {
      case 'home': return { title: '首页' };
      case 'work': return null;
      case 'arrange': {
        const mode = route.mode ?? 'pick';
        if (mode === 'chat') return { title: '对话式', subtitle: '与一个员工直接沟通，边聊边完成工作。' };
        if (mode === 'auto') {
          return {
            title: '自动编排',
            subtitle: '告诉系统你想完成什么，AI 会自动选择员工并安排工作。',
          };
        }
        if (mode === 'manual') {
          return {
            title: '自己编排',
            subtitle: '自己选择员工，并决定员工之间如何协作。',
          };
        }
        return {
          title: '安排工作',
          subtitle: '选择一种适合你的方式开始安排工作。',
        };
      }
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
        <AppTopBar
          title={head?.title}
          subtitle={head?.subtitle}
          actions={(
            /* 铃铛和导航栏「工作记录」右边那个数字指的是同一批工作，点开也是同一页。
               两处都留：数字是导航项的注解，铃铛是设计稿里那个随时都在的入口。 */
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
          )}
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

