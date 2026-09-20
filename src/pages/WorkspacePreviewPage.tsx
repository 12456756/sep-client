import { useState } from 'react';
import { LayoutGrid, Network } from 'lucide-react';
import { AppSideNav } from '../components/enterprise/AppSideNav';
import { AppTopBar } from '../components/enterprise/AppTopBar';
import { Empty } from '../components/enterprise/atoms';
import type { AppRoute } from '../features/enterprise/types';
import { OrganizationEmptyState } from './enterprise/OrganizationEmptyState';
import '../styles/enterprise.css';

/** Browser-only layout inspection. No fake account, platform data, IPC or task execution. */
export function WorkspacePreviewPage(): JSX.Element {
  const [route, setRoute] = useState<AppRoute>({ name: 'organization' });
  const isOrganization = route.name === 'organization';
  return (
    <div className="ent-shell">
      <AppSideNav
        enterpriseName="未连接平台"
        enterpriseMark="—"
        current={route.name}
        needsMeCount={0}
        canManage={false}
        userName="未登录"
        onNavigate={setRoute}
        onLogout={() => setRoute({ name: 'home' })}
      />
      <div className="ent-shell-main">
        <AppTopBar
          title={isOrganization ? '组织架构' : '界面预览'}
          subtitle="浏览器仅预览界面，真实数据请在桌面客户端登录后查看"
          actions={(
            <div className="ent-view-switch" role="group" aria-label="页面切换">
              <button type="button" aria-pressed={!isOrganization} className={!isOrganization ? 'active' : undefined} onClick={() => setRoute({ name: 'home' })}>
                <LayoutGrid size={14} aria-hidden />首页
              </button>
              <button type="button" aria-pressed={isOrganization} className={isOrganization ? 'active' : undefined} onClick={() => setRoute({ name: 'organization' })}>
                <Network size={14} aria-hidden />组织架构
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
      </div>
    </div>
  );
}
