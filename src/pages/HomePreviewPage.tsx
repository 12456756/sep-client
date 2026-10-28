import { FeedbackProvider } from '../components/feedback/FeedbackProvider';
import { useMemo, useState } from 'react';
import { Bell, Command, LayoutGrid, Moon, Network, Sun } from 'lucide-react';
import { AppSideNav } from '../components/enterprise/AppSideNav';
import { AppTopBar } from '../components/enterprise/AppTopBar';
import { HomeDashboard } from './enterprise/HomePageRedesign';
import { createHomeDraft } from '../features/enterprise/home-draft';
import { homePreviewEmployees, homePreviewNow, homePreviewStats, homePreviewUserName, homePreviewWorks } from '../preview/home-fixtures';
import '../styles/enterprise.css';

export function HomePreviewPage(): JSX.Element {
  const [dark, setDark] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [draft] = useState(createHomeDraft);
  const employees = useMemo(() => homePreviewEmployees, []);
  return <FeedbackProvider><div className={`ent-shell${dark ? ' dark' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`} data-theme={dark ? 'dark' : 'light'}>
    <AppSideNav enterpriseName="常州数易网络科技有限公司" enterpriseMark="常" current="home" needsMeCount={0} canManage={false} userName={homePreviewUserName} collapsed={sidebarCollapsed} onNavigate={() => undefined} onOpenSettings={() => undefined} onLogout={() => undefined} />
    <div className="ent-shell-main">
      <AppTopBar sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => setSidebarCollapsed(value => !value)} actions={<div className="ent-top-actions-group"><div className="ent-view-switch" role="group" aria-label="页面切换"><button type="button" className="active" aria-pressed><LayoutGrid size={14} aria-hidden />个人</button><button type="button" aria-pressed="false"><Network size={14} aria-hidden />企业</button></div><button type="button" className="ent-top-command" aria-label="打开命令入口"><Command size={14} aria-hidden /><span>⌘K</span></button><button type="button" className="ent-top-icon" aria-label={dark ? '切换到浅色主题' : '切换到深色主题'} onClick={() => setDark(value => !value)}>{dark ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}</button><button type="button" className="ent-top-icon" aria-label="工作提醒"><Bell size={16} aria-hidden /></button></div>} />
      <div className="ent-scroll ent-scroll-home"><HomeDashboard userName={homePreviewUserName} employees={employees} works={homePreviewWorks} draft={draft} demo now={homePreviewNow} visualStats={homePreviewStats} onNavigate={() => undefined} onSubmit={async () => true} employeeLoad={{ loading: false, error: null, retry: () => undefined }} employeeStatusLoad={{ loading: false, error: null, retry: () => undefined }} workListLoad={{ loading: false, error: null, retry: () => undefined }} /></div>
    </div>
  </div></FeedbackProvider>;
}
