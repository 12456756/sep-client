/** Employee discovery: find a suitable employee and start work. */

import React, { useMemo, useState } from 'react';
import { LayoutGrid, List, RefreshCw, Search, X } from 'lucide-react';
import { EmployeeCard } from '../../components/enterprise/EmployeeCard';
import { Empty } from '../../components/enterprise/atoms';
import type { EmployeePageState } from '../../features/enterprise/employee-page-state';
import { filterEmployees, employeeChatDisabledReason, employeeSkills, mergeEmployeeDirectory } from '../../features/enterprise/employee-view-model';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { EmployeeAvailability } from '../../features/enterprise/types';
import { EMPLOYEE_AVAILABILITY } from '../../features/enterprise/vocabulary';
import type { EmployeeLoadState } from '../../features/enterprise/use-workspace-employees';

interface Props {
  workspace: EnterpriseWorkspace;
  scope?: 'mine' | 'all';
  state?: EmployeePageState;
  onStateChange?: (patch: Partial<EmployeePageState>) => void;
  employeeLoad?: EmployeeLoadState;
  employeeStatusLoad?: EmployeeLoadState;
}

const DEFAULT_STATE: EmployeePageState = { scope: 'mine', search: '', availability: '', view: 'cards', scrollTop: 0, focusId: null };

export function EmployeesPage({ workspace, scope: initialScope, state: controlledState, onStateChange, employeeLoad, employeeStatusLoad }: Props): React.JSX.Element {
  const [localState, setLocalState] = useState<EmployeePageState>({ ...DEFAULT_STATE, scope: initialScope ?? 'mine' });
  const state = controlledState ?? localState;
  const update = (patch: Partial<EmployeePageState>) => { if (onStateChange) onStateChange(patch); else setLocalState(current => ({ ...current, ...patch })); };
  const scope = state.scope;
  const mergedDirectory = useMemo(() => mergeEmployeeDirectory(workspace.employees, workspace.organizationEmployees), [workspace.employees, workspace.organizationEmployees]);
  const personalIds = useMemo(() => new Set(workspace.employees.map(employee => employee.id)), [workspace.employees]);
  const directory = useMemo(() => scope === 'all' ? mergedDirectory : mergedDirectory.filter(employee => personalIds.has(employee.id)), [scope, mergedDirectory, personalIds]);
  const list = useMemo(() => filterEmployees(directory, workspace.skills, state.search, state.availability), [directory, workspace.skills, state.search, state.availability]);
  const total = directory.length;
  const skillsUnavailable = Boolean(workspace.skillsError && !workspace.skills.length);
  const clearFilters = () => update({ search: '', availability: '' });
  const open = (employeeId: string) => { update({ focusId: `employee-detail-${employeeId}` }); workspace.navigate({ name: 'employee', employeeId }); };
  const chat = (employeeId: string) => workspace.navigate({ name: 'arrange', mode: 'chat', employeeId });
  const organizationLoading = scope === 'all' && workspace.organizationStatus === 'loading';
  const organizationError = scope === 'all' && workspace.organizationStatus === 'error';
  const loading = Boolean(employeeLoad?.loading) || organizationLoading;
  const directoryUnavailable = Boolean(employeeLoad?.error) || organizationError;
  const countUnavailable = loading || directoryUnavailable;
  const statusUnavailable = Boolean(employeeStatusLoad?.loading || employeeStatusLoad?.error);

  return <div className="ent-page ent-employees-page" data-employee-view={state.view}>
    <div className="ent-toolbar ent-employees-toolbar">
      <div className="ent-segment ent-employee-scope" role="group" aria-label="员工范围">
        <button type="button" aria-pressed={scope === 'mine'} className={scope === 'mine' ? 'active' : undefined} onClick={() => update({ scope: 'mine', search: '', availability: '', scrollTop: 0 })}>分配给我的</button>
        <button type="button" aria-pressed={scope === 'all'} className={scope === 'all' ? 'active' : undefined} onClick={() => update({ scope: 'all', search: '', availability: '', scrollTop: 0 })}>企业全部员工</button>
      </div>
      <div className="ent-employees-controls">
        <label className="ent-find ent-employees-search"><Search size={14} aria-hidden /><input type="search" value={state.search} placeholder="搜索员工或技能…" aria-label="搜索员工或技能" onChange={event => update({ search: event.target.value })} /></label>
        <select className="ent-select auto" value={state.availability} onChange={event => update({ availability: event.target.value as '' | EmployeeAvailability })} aria-label="按可用状态筛选"><option value="">全部状态</option>{(['ready', 'working', 'unavailable'] as EmployeeAvailability[]).map(key => <option key={key} value={key}>{EMPLOYEE_AVAILABILITY[key].label}</option>)}</select>
        <div className="ent-segment icon" role="group" aria-label="展示方式"><button type="button" className={state.view === 'cards' ? 'active' : undefined} aria-pressed={state.view === 'cards'} onClick={() => update({ view: 'cards' })} aria-label="卡片视图" title="卡片视图"><LayoutGrid size={14} aria-hidden /></button><button type="button" className={state.view === 'list' ? 'active' : undefined} aria-pressed={state.view === 'list'} onClick={() => update({ view: 'list' })} aria-label="紧凑列表" title="紧凑列表"><List size={14} aria-hidden /></button></div>
      </div>
    </div>
    <div className="ent-employees-result"><strong>{countUnavailable ? (loading ? '员工数量确认中' : '员工数量暂不可用') : state.search.trim() || state.availability ? `找到 ${list.length} / ${total} 名员工` : `${total} 名员工`}</strong>{scope === 'all' ? <span className="ent-employees-legend">企业目录中的未分配员工只能查看详情</span> : null}{state.search.trim() || state.availability ? <button type="button" className="ent-clear-filter" onClick={clearFilters}><X size={13} aria-hidden />清除筛选</button> : null}</div>
    {loading ? <div className="ent-employees-state" role="status">正在加载员工列表…</div> : null}
    {employeeLoad?.error && !employeeLoad.loading ? <div className="ent-banner danger"><span>{employeeLoad.error}</span><button type="button" className="ent-btn sm" onClick={employeeLoad.retry}>重试</button></div> : null}
    {organizationError ? <div className="ent-banner danger"><span>{workspace.organizationError ?? '企业员工目录加载失败'}</span><button type="button" className="ent-btn sm" onClick={workspace.retryOrganization}><RefreshCw size={13} aria-hidden />重试</button></div> : null}
    {workspace.skillsLoading ? <div className="ent-employees-state" role="status">技能正在加载，搜索结果暂不完整。</div> : null}
    {workspace.skillsWarning ? <div className="ent-banner info" role="status">{workspace.skillsWarning} 技能搜索结果可能不完整。</div> : null}
    {workspace.skillsError ? <div className="ent-banner info"><span>{workspace.skillsError}{skillsUnavailable ? ' 当前仅可搜索员工名称和介绍。' : ''}</span><button type="button" className="ent-btn sm" disabled={workspace.skillsLoading || (workspace.skillsRetrySeconds !== null && workspace.skillsRetrySeconds > 0)} onClick={() => void workspace.refreshSkills()}>{workspace.skillsRetrySeconds !== null && workspace.skillsRetrySeconds > 0 ? `${workspace.skillsRetrySeconds} 秒后重试` : '重试技能'}</button></div> : null}
    {!loading && !directoryUnavailable && !list.length ? <Empty title={state.search.trim() || state.availability ? '没有符合条件的员工' : scope === 'all' ? '企业暂无员工' : '暂未分配员工'}>{state.search.trim() || state.availability ? <button type="button" className="link" onClick={clearFilters}>清除筛选</button> : scope === 'all' ? '企业创建员工后，会显示在这里。' : '企业为你分配员工后，会显示在这里。'}</Empty> : null}
    {employeeStatusLoad?.error && !employeeStatusLoad.loading ? <div className="ent-banner info"><span>员工状态暂未更新，确认完成前无法开始新对话。</span><button type="button" className="ent-btn sm" onClick={employeeStatusLoad.retry}>重试</button></div> : null}
    {list.length > 0 ? <div className={state.view === 'list' ? 'ent-emp-list' : 'ent-emp-grid'}>{list.map(employee => {
      const reason = employeeChatDisabledReason(employee) ?? (employeeLoad?.loading || employeeLoad?.error ? '员工订阅正在确认或暂不可用' : statusUnavailable ? '员工状态正在确认或暂不可用' : null);
      return <EmployeeCard key={employee.id} employee={employee} skills={employeeSkills(workspace.skills, employee.id)} chatDisabledReason={reason} onOpen={open} onChat={reason ? undefined : chat} compact={state.view === 'list'} />;
    })}</div> : null}
  </div>;
}
