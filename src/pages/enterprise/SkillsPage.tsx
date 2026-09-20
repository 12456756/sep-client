import { BookOpen, ChevronRight, RefreshCw, Search } from 'lucide-react';
import { useState } from 'react';
import { Empty } from '../../components/enterprise/atoms';
import { EmployeeFace } from '../../components/enterprise/EmployeeFace';
import { SkillDetail } from '../../components/enterprise/skills/SkillDetail';
import { localSkillVersionStatus, selectedSkillVersion, skillVersionLabel, skillVersionStatus } from '../../features/enterprise/skill-labels';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { SkillLibraryItem } from '../../shared/skill-library';
import '../../styles/skills.css';

interface Props { workspace: EnterpriseWorkspace; skillId?: string }
export function SkillsPage({ workspace, skillId }: Props) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const skill = workspace.skills.find(item => item.capability.id === skillId);
  if (skill) return <SkillDetail key={skill.capability.id} workspace={workspace} skill={skill} />;
  const matches = workspace.skills.filter(item => `${item.capability.name} ${item.capability.description}`.toLowerCase().includes(query.trim().toLowerCase()) && (filter !== 'personal' || item.versions.some(version => version.scope === 'PERSONAL') || item.localVersions.length));
  return <div className="ent-page skill-library">
    <div className="skill-toolbar">
      <label className="skill-search"><Search size={17} aria-hidden /><input aria-label="搜索技能" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索技能名称、描述或关键词…" /></label>
      <select className="ent-select" aria-label="版本范围" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部技能</option><option value="personal">有个人版本</option></select>
      <button className="ent-btn" disabled={workspace.skillsLoading} onClick={() => void workspace.refreshSkills()}><RefreshCw size={15} aria-hidden />刷新</button>
    </div>
    <p className="skill-caption">共 {workspace.skills.length} 个技能 · 修改保存为个人版本，不覆盖企业发布版</p>
    {workspace.skillsError ? <div className="ent-banner danger" role="alert">{workspace.skillsError}，请点击刷新重试。</div> : null}
    {workspace.skillsLoading && !workspace.skills.length ? <div role="status">正在加载技能…</div> : null}
    {skillId && !workspace.skillsLoading ? <div className="ent-banner info">此技能不在当前授权列表中。</div> : null}
    {!workspace.skillsLoading && !matches.length && !workspace.skillsError ? <Empty title={query || filter !== 'all' ? '没有匹配的技能' : '暂无可用技能'}>企业给你的硅基员工配置技能后，会显示在这里。</Empty> : null}
    <div className="skill-cards">{matches.map(item => <SkillCard key={item.capability.id} skill={item} workspace={workspace} />)}</div>
  </div>;
}

function SkillCard({ skill, workspace }: { skill: SkillLibraryItem; workspace: EnterpriseWorkspace }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const selected = selectedSkillVersion(skill);
  const publicVersions = [...new Set(skill.bindings.map(binding => skillVersionLabel(binding.currentVersion)))];
  const select = async (versionId: string): Promise<void> => {
    setSaving(true); setError('');
    try { await workspace.selectSkillVersion(skill.capability.id, versionId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '切换失败'); }
    finally { setSaving(false); }
  };
  return <article className="skill-card">
    <div className="skill-card-heading"><div className="skill-icon"><BookOpen size={25} aria-hidden /></div><div className="skill-card-title"><h2>{skill.capability.name}</h2><p>{skill.capability.description || '暂无技能说明'}</p></div><span className="skill-badge">企业可用技能</span></div>
    <div className="skill-public-version">企业可用发布版本 <strong>{publicVersions.join(' / ')}</strong></div>
    <div className="skill-card-bottom">
      <div className="skill-users"><span className="skill-caption">使用此技能的硅基员工</span><div className="skill-employee-chips">{skill.bindings.map(binding => {
        const employee = workspace.employees.find(item => item.id === binding.subscriptionId);
        const active = skill.versions.find(version => version.id === binding.selectedVersionId);
        const local = skill.localVersions.find(version => version.idempotencyKey === binding.selectedVersionId);
        return <span className="skill-employee" key={binding.subscriptionId} title={`${employee?.name ?? binding.employeeId} · ${active ? skillVersionLabel(active) : local?.request.changeSummary || (local ? '个人修改版' : '版本不可用')}`}><EmployeeFace employee={employee} name={employee?.name ?? binding.employeeId} size="sm" round /><span>{employee?.name ?? binding.employeeId}</span></span>;
      })}</div></div>
      <label className="skill-active-version"><span className="skill-caption">当前使用版本</span><select className="ent-select" aria-label={`${skill.capability.name}当前使用版本`} value={selected} disabled={saving} onChange={event => void select(event.target.value)}>
        {!selected ? <option value="" disabled>员工使用不同版本</option> : !skill.versions.some(version => version.id === selected) && !skill.localVersions.some(version => version.idempotencyKey === selected) ? <option value={selected} disabled>已选版本不可用，请重新选择</option> : null}
        {skill.versions.map(version => <option key={version.id} value={version.id} disabled={!skill.usableVersionIds.includes(version.id)}>{skillVersionLabel(version)}{!skill.usableVersionIds.includes(version.id) ? ` · ${skillVersionStatus(version.status)}` : ''}</option>)}
        {skill.localVersions.map(version => <option key={version.idempotencyKey} value={version.idempotencyKey} disabled={!skill.usableVersionIds.includes(version.idempotencyKey)}>{version.request.changeSummary || '个人修改版'} · {localSkillVersionStatus(skill, version)}</option>)}
      </select></label>
      <button className="ent-btn primary" onClick={() => workspace.navigate({ name: 'skills', skillId: skill.capability.id })}>查看并调整<ChevronRight size={15} aria-hidden /></button>
    </div>
    {saving ? <p role="status" className="skill-caption">正在切换版本…</p> : null}
    {error ? <p role="alert" className="skill-error">{error}</p> : null}
    <small className="skill-caption">版本切换应用于上述员工的下一次技能加载；本地修改仅本人可用，无需等待审核，不影响企业发布版本。</small>
  </article>;
}
