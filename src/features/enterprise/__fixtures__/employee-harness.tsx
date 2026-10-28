import { useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EmployeesPage } from '../../../pages/enterprise/EmployeesPage';
import { EmployeeDetailDrawer } from '../../../components/enterprise/EmployeeDetailDrawer';
import { createEmployeePageState, employeeBackgroundRoute, enterEmployeePage, readEmployeeView, saveEmployeeView, type EmployeePageState } from '../employee-page-state';
import { useEmployeePageScroll } from '../use-employee-page-scroll';
import type { EnterpriseWorkspace } from '../useEnterpriseWorkspace';
import type { AppRoute, SiliconEmployee, WorkItem } from '../types';
import type { SkillLibraryItem } from '../../../shared/skill-library';
import '../../../index.css';
import '../../../styles/enterprise.css';
import '../../../styles/employees.css';
import '../../../styles/employee-detail.css';

const makeEmployee = (index: number, assignedToMe = true): SiliconEmployee => ({
  id: `employee-${index}`, name: index === 1 ? '爆品机会评估师' : index === 27 ? '资料助手' : `${assignedToMe ? '运营顾问' : '企业员工'} ${index}`,
  avatar: null, avatarAsset: null, mark: '员', roleName: '', department: null,
  availability: index === 3 ? 'working' : index === 4 ? 'unavailable' : 'ready', assignedToMe,
  intro: index === 27 ? '' : index === 2 ? '负责独特的会员权益方案整理' : '根据你提供的资料，整理分析结果并形成工作建议。',
  goodAt: [], cannotDo: [], lastWorkedAt: index === 27 ? null : Date.now() - index * 3600000,
  allowedModels: ['fixture-model'], skillIds: [], permissions: [], templateVersion: 'fixture',
});
const employees = Array.from({ length: 27 }, (_, index) => makeEmployee(index + 1));
const organizationEmployees = [...employees, ...Array.from({ length: 3 }, (_, index) => makeEmployee(index + 28, false))];
const skills: SkillLibraryItem[] = Array.from({ length: 26 }, (_, index) => ({
  capability: { id: `skill-${index + 1}`, name: index === 0 ? '商品机会研究' : `业务资料整理 ${index + 1}`, description: '整理资料、分析重点，并输出清晰的建议。', type: 'skill' },
  bindings: [{ subscriptionId: `employee-${index + 1}`, employeeId: `platform-${index + 1}`, currentVersion: null, selectedVersionId: null }],
  versions: [], usableVersionIds: [], localVersions: [],
}));
const works: WorkItem[] = Array.from({ length: 4 }, (_, index) => ({
  id: `work-${index + 1}`, title: `商品机会评估 ${index + 1}`, goal: '分析商品机会', kind: 'conversation', workType: { state: 'resolved', kind: 'conversation' },
  status: index === 0 ? 'running' : 'completed', progress: index === 0 ? 50 : 100, currentEmployeeId: 'employee-1', currentEmployeeName: employees[0].name,
  steps: [], nextUserAction: null, createdAt: Date.now() - 86400000, startedAt: null, completedAt: null, updatedAt: Date.now() - index * 3600000,
  participants: ['employee-1'], deliverables: [], timeline: [], messages: [], activities: [], sharedContext: { goal: '', confirmedInputs: [], previousResults: [], userNotes: [] },
  stopReason: null, workDir: null,
}));

function FixtureWorkspace({ account }: { account: string }) {
  const [navigation, setNavigation] = useState<{ route: AppRoute; history: AppRoute[] }>({ route: { name: 'employees' }, history: [] });
  const [state, setState] = useState(() => createEmployeePageState(readEmployeeView(account)));
  const [scenario, setScenario] = useState('ready');
  const [dark, setDark] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const updateState = useCallback((patch: Partial<EmployeePageState>) => {
    setState(current => ({ ...current, ...patch }));
    if (patch.view) saveEmployeeView(account, patch.view);
  }, [account]);
  const navigate = useCallback((route: AppRoute) => {
    if (route.name === 'employees' && route.scope) setState(current => enterEmployeePage(current, route.scope));
    setNavigation(current => ({ route, history: [...current.history, current.route] }));
  }, []);
  const goBack = useCallback(() => setNavigation(current => ({ route: current.history.at(-1) ?? { name: 'employees' }, history: current.history.slice(0, -1) })), []);
  const replaceRoute = useCallback((route: AppRoute) => setNavigation(current => ({ ...current, route })), []);
  const retry = () => setScenario('ready');
  const loading = scenario === 'loading';
  const skillsLoading = scenario === 'skills-loading';
  const skillError = scenario === 'skills-error' || scenario === 'rate-limit';
  const workspace = {
    attachmentScopeKey: account, employees: loading ? [] : employees, myEmployees: employees, organizationEmployees,
    skills: skillError || skillsLoading ? [] : skills, skillsLoading, skillsError: skillError ? '技能服务暂时不可用' : null,
    skillsRetrySeconds: scenario === 'rate-limit' ? 10 : null, skillsErrorKind: scenario === 'rate-limit' ? 'rate-limited' : null,
    refreshSkills: async () => retry(), organizationStatus: scenario === 'organization-error' ? 'error' : 'ready',
    organizationError: scenario === 'organization-error' ? '企业目录加载失败' : null, retryOrganization: retry,
    works, workListLoad: { loading: false, error: null, retry }, route: navigation.route, canGoBack: navigation.history.length > 0,
    navigate, goBack, replaceRoute, busy: false, employeePageState: state, updateEmployeePageState: updateState,
  } as unknown as EnterpriseWorkspace;
  const employeeLoad = { loading, error: null, retry };
  const ready = !loading && !skillsLoading;
  const backgroundRoute = employeeBackgroundRoute(navigation.route, navigation.history);
  useEmployeePageScroll(scroll, backgroundRoute, state, updateState, ready);

  return <div className={`ent-shell${dark ? ' dark' : ''}`} style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: 12, flex: 'none', background: 'var(--ent-panel)', color: 'var(--ent-ink)' }}>
      <span>独立员工页面验收 · {account}</span>
      <select aria-label="数据场景" value={scenario} onChange={event => setScenario(event.target.value)}>{['ready', 'loading', 'skills-loading', 'skills-error', 'rate-limit', 'organization-error'].map(value => <option key={value}>{value}</option>)}</select>
      <button type="button" onClick={() => setDark(value => !value)} aria-label="切换主题">{dark ? '浅色' : '深色'}</button>
      <button type="button" onClick={() => navigate({ name: 'employees', scope: 'mine' })}>重新进入我的员工</button>
      <button type="button" onClick={() => navigate({ name: 'home' })}>进入首页来源</button>
      <output data-testid="route">{JSON.stringify(navigation.route)}</output>
    </div>
    <div ref={scroll} className="ent-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      {backgroundRoute.name === 'employees' ? <EmployeesPage workspace={workspace} state={state} onStateChange={updateState} employeeLoad={employeeLoad} />
        : <div className="ent-page"><button type="button" onClick={goBack}>返回来源</button><h1>目标页面</h1>{backgroundRoute.name === 'home' ? <button type="button" onClick={() => navigate({ name: 'employee', employeeId: 'employee-1' })}>从首页查看员工</button> : null}<output data-testid="destination">{JSON.stringify(backgroundRoute)}</output></div>}
    </div>
    {navigation.route.name === 'employee' ? <EmployeeDetailDrawer workspace={workspace} employeeId={navigation.route.employeeId} employeeLoad={employeeLoad} /> : null}
  </div>;
}

function Harness() {
  const [account, setAccount] = useState('account-a');
  return <><button type="button" style={{ position: 'fixed', right: 12, bottom: 12, zIndex: 100 }} onClick={() => setAccount(value => value === 'account-a' ? 'account-b' : 'account-a')}>切换账号</button><FixtureWorkspace key={account} account={account} /></>;
}

createRoot(document.getElementById('root')!).render(<Harness />);
