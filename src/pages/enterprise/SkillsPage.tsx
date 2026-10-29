import { ChevronRight, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Empty } from '../../components/enterprise/atoms';
import { EmployeeFace } from '../../components/enterprise/EmployeeFace';
import { SkillDetail } from '../../components/enterprise/skills/SkillDetail';
import { hasPersonalSkillVersion, selectSkillList, skillEmployeeOptions, skillUsageSummary, uniqueSkillBindings, type SkillSort } from '../../features/enterprise/skill-list-model';
import { createSkillPageState, type SkillPageState } from '../../features/enterprise/skill-page-state';
import { buildSkillSelectionOptions, findSkillVersion, unifiedSkillSelection } from '../../features/enterprise/skill-version-model';
import type { AppRoute } from '../../features/enterprise/types';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { SkillLibraryItem } from '../../shared/skill-library';
import '../../styles/skills.css';

type SkillsRoute = Extract<AppRoute, { name: 'skills' }>;
interface Props {
  workspace: EnterpriseWorkspace;
  skillId?: string;
  employeeFilterId?: string;
  sourceEmployeeId?: string;
  returnTo?: SkillsRoute['returnTo'];
}

export function SkillsPage({ workspace, skillId, employeeFilterId, sourceEmployeeId, returnTo }: Props): React.JSX.Element {
  const skill = workspace.skills.find(item => item.capability.id === skillId);
  if (skill) return <SkillDetail key={`${workspace.attachmentScopeKey}:${skill.capability.id}`} workspace={workspace} skill={skill} sourceEmployeeId={sourceEmployeeId} returnTo={returnTo} />;
  return <SkillList key={workspace.attachmentScopeKey} workspace={workspace} employeeFilterId={employeeFilterId} missingSkillId={skillId} />;
}

function SkillList({ workspace, employeeFilterId, missingSkillId }: { workspace: EnterpriseWorkspace; employeeFilterId?: string; missingSkillId?: string }): React.JSX.Element {
  const [localState, setLocalState] = useState(() => ({ ...createSkillPageState(), employeeFilterId: employeeFilterId ?? '' }));
  const [pending, setPending] = useState<{ skillId: string; versionId: string } | null>(null);
  const [switchError, setSwitchError] = useState<{ skillId: string; versionId: string; message: string } | null>(null);
  const [switchNotice, setSwitchNotice] = useState('');
  const switching = useRef(false);
  const alive = useRef(true);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const { registerSkillLeaveGuard } = workspace;
  useLayoutEffect(() => registerSkillLeaveGuard?.(() => !switching.current), [registerSkillLeaveGuard]);
  useEffect(() => {
    if (!pending) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [pending]);
  const state = workspace.skillPageState ?? localState;
  const { updateSkillPageState } = workspace;
  const update = (patch: Partial<SkillPageState>) => {
    const next = { ...patch, scrollTop: 0, anchorId: null, focusId: null, notice: '' };
    if (updateSkillPageState) updateSkillPageState(next);
    else setLocalState(current => ({ ...current, ...next }));
  };
  const options = useMemo(() => skillEmployeeOptions(workspace.skills, workspace.employees), [workspace.skills, workspace.employees]);
  const matches = useMemo(() => selectSkillList(workspace.skills, workspace.employees, state), [workspace.skills, workspace.employees, state]);
  const total = new Set(workspace.skills.map(skill => skill.capability.id)).size;
  const hasCachedSkills = total > 0;
  const hasError = Boolean(workspace.skillsError);
  const filtered = Boolean(state.query.trim() || state.employeeFilterId || state.versionFilter !== 'all');
  const canRetry = !pending && !workspace.skillsLoading && (workspace.skillsRetrySeconds == null || workspace.skillsRetrySeconds <= 0);

  useEffect(() => {
    if (workspace.skillsLoading || workspace.skillsError || !state.employeeFilterId || options.some(option => option.id === state.employeeFilterId)) return;
    const patch = { employeeFilterId: '', scrollTop: 0, anchorId: null, focusId: null, notice: '该员工已不在当前技能列表中，已显示全部员工。' };
    if (updateSkillPageState) updateSkillPageState(patch);
    else setLocalState(current => ({ ...current, ...patch }));
  }, [workspace.skillsLoading, workspace.skillsError, state.employeeFilterId, options, updateSkillPageState]);

  const open = (id: string) => {
    const patch = { focusId: `skill-detail-${id}` };
    if (updateSkillPageState) updateSkillPageState(patch);
    else setLocalState(current => ({ ...current, ...patch }));
    workspace.navigate({ name: 'skills', skillId: id, sourceEmployeeId: state.employeeFilterId || undefined, returnTo: { name: 'skill-list' } });
  };
  const switchVersion = async (skill: SkillLibraryItem, versionId: string): Promise<void> => {
    const versions = buildSkillSelectionOptions(skill);
    const version = findSkillVersion(versions, versionId);
    if (switching.current || !version?.usable || !skill.bindings.length || unifiedSkillSelection(skill, versions)?.id === version.id) return;
    switching.current = true;
    setPending({ skillId: skill.capability.id, versionId: version.id }); setSwitchError(null); setSwitchNotice('');
    try {
      await workspace.selectSkillVersion(skill.capability.id, version.id);
      if (alive.current) setSwitchNotice(`已切换为${version.label}，应用于全部 ${uniqueSkillBindings(skill).length} 名关联员工。`);
    } catch (cause) {
      if (alive.current) setSwitchError({ skillId: skill.capability.id, versionId: version.id, message: cause instanceof Error ? cause.message : '版本切换失败' });
    } finally {
      switching.current = false;
      if (alive.current) setPending(null);
    }
  };
  const retrySkill = switchError ? workspace.skills.find(skill => skill.capability.id === switchError.skillId) : undefined;
  return <div className="ent-page skill-library" aria-busy={workspace.skillsLoading} data-skill-list>
    <div className="skill-toolbar">
      <label className="skill-search"><Search size={16} aria-hidden /><input type="search" aria-label="搜索技能或员工" value={state.query} onChange={event => update({ query: event.target.value })} placeholder="搜索技能或员工…" /></label>
      <select className="ent-select" aria-label="按员工筛选" value={state.employeeFilterId} onChange={event => update({ employeeFilterId: event.target.value, query: '' })}><option value="">全部员工</option>{state.employeeFilterId && !options.some(option => option.id === state.employeeFilterId) ? <option value={state.employeeFilterId}>正在确认员工…</option> : null}{options.map(option => <option key={option.id} value={option.id}>{option.label} · {option.count}</option>)}</select>
      <select className="ent-select" aria-label="版本范围" value={state.versionFilter} onChange={event => update({ versionFilter: event.target.value as SkillPageState['versionFilter'] })}><option value="all">全部版本</option><option value="personal">个人</option><option value="enterprise">企业</option><option value="platform">平台</option></select>
      <select className="ent-select" aria-label="技能排序" value={state.sort} onChange={event => update({ sort: event.target.value as SkillSort })}><option value="name">名称排序</option><option value="employees">关联员工最多</option><option value="recent">最近个人修改</option></select>
      <button type="button" className="ent-btn" disabled={!canRetry} onClick={() => void workspace.refreshSkills()}><RefreshCw size={15} aria-hidden />{workspace.skillsLoading ? '刷新中…' : '刷新'}</button>
    </div>
    <div className="skill-list-meta"><p className="skill-caption" role="status">{hasCachedSkills || !workspace.skillsLoading && !hasError ? filtered ? `找到 ${matches.length} / ${total} 个技能` : `共 ${total} 个技能` : workspace.skillsLoading ? '正在确认技能数量' : '技能数量暂不可用'}</p>{filtered ? <button type="button" className="skill-text-button" onClick={() => update({ query: '', employeeFilterId: '', versionFilter: 'all' })}><X size={13} aria-hidden />清除筛选</button> : null}</div>
    {state.notice ? <p className="skill-caption" role="status">{state.notice}</p> : null}
    {switchNotice ? <p className="skill-caption" role="status">{switchNotice}</p> : null}
    {switchError ? <div className="ent-banner danger skill-state-banner" role="alert"><span>{switchError.message}</span><div className="skill-switch-recovery"><button type="button" className="ent-btn sm" disabled={Boolean(pending) || !retrySkill || !findSkillVersion(buildSkillSelectionOptions(retrySkill), switchError.versionId)?.usable} onClick={() => { if (retrySkill) void switchVersion(retrySkill, switchError.versionId); }}>重试切换</button><button type="button" className="ent-btn sm" disabled={!canRetry || Boolean(pending)} onClick={() => void workspace.refreshSkills()}>刷新使用情况</button></div></div> : null}
    {workspace.skillsWarning ? <div className="ent-banner info" role="status">{workspace.skillsWarning}</div> : null}
    {hasError ? <div className="ent-banner danger skill-state-banner" role="alert"><div><strong>{workspace.skillsError}</strong>{hasCachedSkills ? <span>已保留上次成功加载的技能列表。</span> : null}</div><button type="button" className="ent-btn sm" disabled={!canRetry} onClick={() => void workspace.refreshSkills()}>{workspace.skillsRetrySeconds != null && workspace.skillsRetrySeconds > 0 ? `${workspace.skillsRetrySeconds} 秒后重试` : '重试'}</button></div> : null}
    {workspace.skillsLoading && !hasCachedSkills ? <div className="skill-loading" role="status"><span className="ent-skeleton ent-skeleton-line wide" aria-hidden /><span className="ent-skeleton ent-skeleton-line medium" aria-hidden /><span>正在加载技能…</span></div> : null}
    {workspace.skillsLoading && hasCachedSkills ? <p className="skill-refreshing" role="status"><RefreshCw size={14} aria-hidden />正在更新技能，当前列表仍可使用。</p> : null}
    {missingSkillId && !workspace.skillsLoading && !hasError ? <div className="ent-banner info">该技能不在当前授权列表中。<button type="button" className="ent-btn sm" onClick={() => workspace.navigate({ name: 'skills' })}>返回技能列表</button></div> : null}
    {!workspace.skillsLoading && !hasError && !matches.length ? <Empty title={filtered ? '没有匹配的技能' : '当前账号还没有已授权的员工技能'}>{filtered ? '请尝试调整搜索词或清除筛选条件。' : '企业给你的硅基员工配置技能后，会显示在这里。'}</Empty> : null}
    {matches.length ? <section className="skill-list-surface" aria-label="员工技能列表"><div className="skill-list-columns" aria-hidden><span>技能 / 简介</span><span>关联员工</span><span>使用版本 · 全部关联员工</span><span>操作</span></div><ul className="skill-rows">{matches.map(item => <SkillRow key={item.capability.id} skill={item} options={options} pendingVersionId={pending?.skillId === item.capability.id ? pending.versionId : undefined} disabled={Boolean(pending)} onVersion={id => void switchVersion(item, id)} onOpen={() => open(item.capability.id)} onEmployee={id => update({ employeeFilterId: id, query: '' })} />)}</ul></section> : null}
  </div>;
}

function SkillRow({ skill, options, pendingVersionId, disabled, onVersion, onOpen, onEmployee }: { skill: SkillLibraryItem; options: ReturnType<typeof skillEmployeeOptions>; pendingVersionId?: string; disabled: boolean; onVersion: (id: string) => void; onOpen: () => void; onEmployee: (id: string) => void }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const bindings = uniqueSkillBindings(skill);
  const name = skill.capability.name.trim() || '未命名技能';
  const summary = skillUsageSummary(skill);
  const versions = buildSkillSelectionOptions(skill);
  const selected = unifiedSkillSelection(skill, versions);
  return <li className="skill-row" data-skill-id={skill.capability.id}>
    <div className="skill-row-identity"><h2><button type="button" id={`skill-detail-${skill.capability.id}`} disabled={disabled} onClick={onOpen}>{name}</button>{hasPersonalSkillVersion(skill) ? <span className="skill-badge">有个人版本</span> : null}</h2>{skill.capability.description ? <details className="skill-description"><summary>{skill.capability.description}</summary><p>{skill.capability.description}</p></details> : null}</div>
    <div className="skill-row-employees">{(expanded ? bindings : bindings.slice(0, 2)).map(binding => {
      const option = options.find(option => option.id === binding.subscriptionId);
      return <button type="button" className="skill-employee" key={binding.subscriptionId} onClick={() => onEmployee(binding.subscriptionId)} aria-label={`筛选员工：${option?.label ?? binding.subscriptionId}`}><EmployeeFace employee={option?.employee} name={option?.employee?.name ?? '?'} size="sm" round /><span>{option?.label ?? '员工信息暂不可用'}</span></button>;
    })}{bindings.length > 2 ? <button type="button" className="skill-more-employees" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : `+${bindings.length - 2}`}</button> : null}</div>
    <div className="skill-row-version"><select className="ent-select skill-version-select" id={`skill-version-${skill.capability.id}`} aria-label={`切换使用版本：${name}（全部 ${bindings.length} 名关联员工）`} aria-busy={Boolean(pendingVersionId)} value={pendingVersionId ?? selected?.id ?? ''} disabled={disabled || !bindings.length || !versions.some(version => version.usable)} onChange={event => onVersion(event.target.value)}>{!selected ? <option value="" disabled>{summary}</option> : null}{versions.map(version => <option key={version.id} value={version.id} disabled={!version.usable}>{version.label}{!version.usable ? ' · 不可用' : ''}</option>)}</select>{pendingVersionId ? <span className="skill-caption" role="status">切换中…</span> : null}</div>
    <button type="button" className="skill-text-button skill-row-open" disabled={disabled} onClick={onOpen} aria-label={`查看详情：${name}`}>查看详情<ChevronRight size={14} aria-hidden /></button>
  </li>;
}
