import { ArrowLeft, Check, FileText, Pencil, RefreshCw, Save, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EnterpriseWorkspace } from '../../../features/enterprise/useEnterpriseWorkspace';
import type { AppRoute } from '../../../features/enterprise/types';
import { buildSkillVersions, findSkillVersion, initialSkillViewingVersion, skillDateLabel, skillReadingParts } from '../../../features/enterprise/skill-version-model';
import { uniqueSkillBindings } from '../../../features/enterprise/skill-list-model';
import type { SkillLibraryItem } from '../../../shared/skill-library';
import '../../../styles/skill-detail.css';

interface Props {
  workspace: EnterpriseWorkspace;
  skill: SkillLibraryItem;
  sourceEmployeeId?: string;
  returnTo?: Extract<AppRoute, { name: 'skills' }>['returnTo'];
}
type Operation = 'save' | 'upload' | null;
const readingComponents = { a: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>, img: ({ alt }: { alt?: string }) => <span className="skill-caption">[图片：{alt || '未加载'}]</span> };

export function SkillDetail({ workspace, skill, sourceEmployeeId, returnTo }: Props): React.JSX.Element {
  const entries = useMemo(() => buildSkillVersions(skill), [skill]);
  const bindings = uniqueSkillBindings(skill);
  const [viewingVersionId, setViewingVersionId] = useState(() => initialSkillViewingVersion(skill, sourceEmployeeId));
  const [tab, setTab] = useState<'description' | 'history'>('description');
  const [mode, setMode] = useState<'read' | 'raw'>('read');
  const [source, setSource] = useState('');
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<Operation>(null);
  const [sourceError, setSourceError] = useState('');
  const [actionError, setActionError] = useState<{ message: string; phase: Exclude<Operation, null>; key?: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [savedId, setSavedId] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState('');
  const [reload, setReload] = useState(0);
  const sourceCache = useRef(new Map<string, string>());
  const saveAttempt = useRef<{ key: string; signature: string } | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  const busy = operation !== null;
  const dirty = editing && content !== source;
  const entry = findSkillVersion(entries, viewingVersionId);
  const parentVersionId = entry?.parentVersionId;
  const validParent = Boolean(parentVersionId && skill.versions.some(version => version.id === parentVersionId));
  const retrySeconds = workspace.skillsRetrySeconds ?? 0;
  const canRefresh = !workspace.skillsLoading && !busy && !dirty && retrySeconds <= 0;
  const { previewSkillSource, registerSkillLeaveGuard } = workspace;

  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setSourceError(''); setSource(''); setContent('');
    if (!viewingVersionId) { setLoading(false); return; }
    const cached = sourceCache.current.get(viewingVersionId);
    if (cached !== undefined) { setSource(cached); setContent(cached); setLoading(false); return; }
    void previewSkillSource(skill.capability.id, viewingVersionId).then(text => {
      if (active) { sourceCache.current.set(viewingVersionId, text); setSource(text); setContent(text); }
    }).catch(cause => { if (active) setSourceError(cause instanceof Error ? cause.message : '读取失败'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [skill.capability.id, viewingVersionId, previewSkillSource, reload]);

  useEffect(() => {
    if (workspace.skillsLoading || workspace.skillsError || entry || dirty || busy) return;
    const fallback = initialSkillViewingVersion(skill, sourceEmployeeId);
    if (fallback !== viewingVersionId) { setEditing(false); setViewingVersionId(fallback); setNotice('原查看版本已不在当前列表中，已更新查看内容。'); }
  }, [workspace.skillsLoading, workspace.skillsError, entry, dirty, busy, skill, sourceEmployeeId, viewingVersionId]);
  useEffect(() => { if (editing) editor.current?.focus(); }, [editing]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, busy]);
  useLayoutEffect(() => registerSkillLeaveGuard?.(() => !busy && (!dirty || window.confirm('有尚未保存的修改，确定放弃吗？'))), [registerSkillLeaveGuard, dirty, busy]);

  const mayDiscard = (): boolean => !busy && (!dirty || window.confirm('有尚未保存的修改，确定放弃吗？'));
  const view = (id: string): void => {
    if (!mayDiscard()) return;
    const next = findSkillVersion(entries, id);
    if (!next) return;
    setEditing(false); setViewingVersionId(next.id); setTab('description'); setNotice(''); setSourceError('');
  };
  const back = (): void => {
    if (!registerSkillLeaveGuard && !mayDiscard()) return;
    const employee = returnTo?.name === 'employee' ? workspace.employees.concat(workspace.organizationEmployees ?? []).find(item => item.id === returnTo.employeeId) : undefined;
    if (returnTo?.name === 'employee' && !employee) {
      workspace.updateSkillPageState?.({ notice: '来源员工已不在当前列表中，已返回技能列表。' });
      workspace.navigate({ name: 'skills' });
      return;
    }
    if (workspace.canGoBack) { workspace.goBack(); return; }
    workspace.navigate(employee ? { name: 'employee', employeeId: employee.id } : { name: 'skills' });
  };
  const save = async (): Promise<void> => {
    if (busy || !name.trim() || !content.trim() || !validParent || !parentVersionId || !dirty) return;
    const request = { capabilityId: skill.capability.id, parentVersionId, content, changeSummary: name.trim() };
    const signature = JSON.stringify(request);
    if (saveAttempt.current?.signature !== signature) saveAttempt.current = { key: crypto.randomUUID(), signature };
    setOperation('save'); setActionError(null);
    try {
      const result = await workspace.saveSkillSource(request, saveAttempt.current.key);
      if (!alive.current) return;
      sourceCache.current.set(result.idempotencyKey, content);
      saveAttempt.current = null;
      setSaveOpen(false); setEditing(false); setSource(content); setName(''); setSavedId(result.idempotencyKey);
      setViewingVersionId(result.idempotencyKey);
      setNotice(result.uploaded ? '个人版本已保存，已上传送审。' : '个人版本已保存到本机，上传未成功。');
    } catch (cause) { if (alive.current) setActionError({ phase: 'save', message: cause instanceof Error ? cause.message : '保存失败，请重试' }); }
    finally { if (alive.current) setOperation(null); }
  };
  const retryUpload = async (key: string): Promise<void> => {
    if (busy || dirty) return;
    setOperation('upload'); setActionError(null);
    try {
      const result = await workspace.retrySkillUpload(skill.capability.id, key);
      if (alive.current) setNotice(result.uploaded ? '上传成功，等待审核。' : '上传未成功，版本已保存在本机。');
    } catch (cause) { if (alive.current) setActionError({ phase: 'upload', key, message: cause instanceof Error ? cause.message : '上传失败' }); }
    finally { if (alive.current) setOperation(null); }
  };
  const setTabFromKey = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || dirty || busy) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'description' : event.key === 'End' ? 'history' : tab === 'history' ? 'description' : 'history';
    setTab(next); document.getElementById(`skill-tab-${next}`)?.focus();
  };
  const employeeName = (id: string): string => {
    const employee = workspace.employees.find(item => item.id === id);
    const duplicate = employee && workspace.employees.filter(item => item.name === employee.name).length > 1;
    return employee ? duplicate ? `${employee.name}（${id}）` : employee.name : `员工信息暂不可用（${id}）`;
  };
  const reading = skillReadingParts(content, skill.capability.name);
  const returnLabel = returnTo?.name === 'employee' ? '返回员工详情' : '返回技能列表';
  const returnToList = (): void => {
    workspace.updateSkillPageState?.({ focusId: `skill-version-${skill.capability.id}` });
    workspace.navigate({ name: 'skills' });
  };

  return <div className="ent-page skill-detail">
    <div className="skill-detail-navigation"><button type="button" className="skill-text-button" disabled={busy} onClick={back}><ArrowLeft size={15} aria-hidden />{returnLabel}</button>{returnTo?.name === 'employee' ? <button type="button" className="skill-text-button" disabled={busy} onClick={() => workspace.navigate({ name: 'skills' })}>全部技能</button> : null}</div>
    <header className="skill-detail-heading"><h1>{skill.capability.name || '未命名技能'}</h1></header>
    {notice ? <div className="ent-banner info skill-detail-notice" role="status"><span>{notice}</span>{savedId ? <button type="button" className="ent-btn sm" disabled={busy} onClick={returnToList}>返回列表切换</button> : null}</div> : null}
    {workspace.skillsWarning ? <p className="skill-caption" role="status">{workspace.skillsWarning}</p> : null}
    {workspace.skillsError ? <div className="ent-banner danger skill-state-banner" role="alert"><span>{workspace.skillsError}</span><button type="button" className="ent-btn sm" disabled={!canRefresh} onClick={() => void workspace.refreshSkills()}>{retrySeconds > 0 ? `${retrySeconds} 秒后重试` : '重试刷新'}</button></div> : null}
    {actionError && !(saveOpen && actionError.phase === 'save') ? <div className="ent-banner danger skill-state-banner" role="alert"><span>{actionError.message}</span>{actionError.phase === 'upload' ? <button type="button" className="ent-btn sm" disabled={busy || dirty} onClick={() => void retryUpload(actionError.key!)}>重试上传</button> : <button type="button" className="ent-btn sm" disabled={busy} onClick={() => setSaveOpen(true)}>重试保存</button>}</div> : null}
    <div className="skill-detail-tabs" role="tablist" aria-label="技能详情">{(['description', 'history'] as const).map(item => <button type="button" key={item} role="tab" id={`skill-tab-${item}`} aria-selected={tab === item} aria-controls={`skill-panel-${item}`} tabIndex={tab === item ? 0 : -1} disabled={busy || dirty && item === 'history'} onKeyDown={setTabFromKey} onClick={() => setTab(item)}>{item === 'description' ? '技能说明' : '版本记录'}</button>)}</div>
    <section id="skill-panel-description" role="tabpanel" aria-labelledby="skill-tab-description" hidden={tab !== 'description'}>
      <div className="skill-content-toolbar"><span className="skill-viewing-version">{entry ? entry.label : viewingVersionId ? '查看版本已不可用，草稿已保留' : '暂无版本'}</span><div className="skill-inline-actions">{!editing ? <><div className="ent-segment"><button type="button" aria-pressed={mode === 'read'} className={mode === 'read' ? 'active' : undefined} onClick={() => setMode('read')}>阅读</button><button type="button" aria-pressed={mode === 'raw'} className={mode === 'raw' ? 'active' : undefined} onClick={() => setMode('raw')}>原文</button></div><button type="button" className="ent-btn" disabled={!entry || !validParent || loading || busy || Boolean(sourceError)} onClick={() => { setEditing(true); setActionError(null); }}><Pencil size={14} aria-hidden />创建个人版本</button></> : null}</div></div>
      {sourceError ? <div className="ent-banner danger skill-state-banner" role="alert"><span>{sourceError}</span><button type="button" className="ent-btn sm" disabled={busy} onClick={() => { sourceCache.current.delete(viewingVersionId); setReload(value => value + 1); }}>重新读取</button></div> : null}
      {loading ? <p className="skill-loading" role="status">正在读取原文…</p> : !viewingVersionId ? <div className="skill-document-empty">当前技能暂无可查看的版本。</div> : <div className="skill-document">
        {editing || mode === 'raw' ? <textarea ref={editor} className={`skill-source${editing ? ' editing' : ''}`} aria-label="Skill 原始内容" value={content} readOnly={!editing || busy} maxLength={500000} spellCheck={false} onChange={event => setContent(event.target.value)} /> : sourceError ? null : content.length ? <div className="skill-reading"><Markdown skipHtml remarkPlugins={[remarkGfm]} components={readingComponents}>{reading.body}</Markdown></div> : <p className="skill-caption">此版本内容为空。</p>}
      </div>}
      {editing ? <footer className="skill-editor-footer"><button type="button" className="ent-btn" disabled={busy} onClick={() => { if (mayDiscard()) { setContent(source); setEditing(false); setActionError(null); } }}>取消修改</button><button type="button" className="ent-btn primary" disabled={busy || !content.trim() || !dirty || !validParent} onClick={() => setSaveOpen(true)}><Save size={14} aria-hidden />保存为个人版本</button></footer> : null}
      {editing && !validParent ? <p className="skill-error" role="alert">来源版本已不可用，草稿仍保留，当前无法保存。请核对技能状态后重试。</p> : null}
    </section>
    <section className="skill-history" id="skill-panel-history" role="tabpanel" aria-labelledby="skill-tab-history" hidden={tab !== 'history'}>
      <div className="skill-history-toolbar"><button type="button" className="skill-text-button" disabled={!canRefresh} onClick={() => void workspace.refreshSkills()}><RefreshCw size={13} aria-hidden />{workspace.skillsLoading ? '刷新中…' : retrySeconds > 0 ? `${retrySeconds} 秒后重试` : '刷新状态'}</button></div>
      {entries.length ? entries.map(item => <div className={`skill-version-row${entry?.id === item.id ? ' active' : ''}`} key={item.id}><FileText size={19} aria-hidden /><div className="skill-version-info"><strong>{item.label}{item.local || item.version?.scope === 'PERSONAL' ? <span className="skill-badge">个人</span> : null}</strong><small>{item.status} · {skillDateLabel(item.createdAt)}</small>{item.version?.rejectionReason ? <small className="skill-error">驳回原因：{item.version.rejectionReason}</small> : null}{item.usedBy.length ? <details className="skill-version-used"><summary><Check size={12} aria-hidden />{item.usedBy.length === bindings.length ? `全部 ${bindings.length} 名员工使用` : `${item.usedBy.length} / ${bindings.length} 名员工使用`}</summary><p>{item.usedBy.map(employeeName).join('、')}</p></details> : null}</div><button type="button" className="ent-btn sm" disabled={busy} onClick={() => view(item.id)}>{entry?.id === item.id ? '正在查看' : '查看内容'}</button>{item.local && !item.local.uploadedVersion ? <button type="button" className="ent-btn sm" disabled={busy || dirty} onClick={() => void retryUpload(item.id)}>{operation === 'upload' ? '正在上传…' : '重试上传'}</button> : null}</div>) : <p className="skill-document-empty">当前技能暂无可查看的版本。</p>}
    </section>
    <Dialog.Root open={saveOpen} onOpenChange={open => { if (!busy) setSaveOpen(open); }}><Dialog.Portal><Dialog.Overlay className="skill-dialog-overlay" /><Dialog.Content className="skill-save-dialog"><Dialog.Title>保存为个人版本</Dialog.Title><Dialog.Description>保存新版本并上传送审，不会自动启用。</Dialog.Description><label className="ent-field"><span>版本名称 / 修改说明</span><input className="ent-input" value={name} maxLength={2000} onChange={event => setName(event.target.value)} placeholder="例如：我的优化版" disabled={busy} /></label>{actionError?.phase === 'save' ? <p role="alert" className="skill-error">{actionError.message}</p> : null}<footer><Dialog.Close asChild><button type="button" className="ent-btn" disabled={busy}>取消</button></Dialog.Close><button type="button" className="ent-btn primary" disabled={busy || !name.trim() || !content.trim() || !validParent} onClick={() => void save()}>{operation === 'save' ? '正在保存并上传…' : '确定保存'}</button></footer><Dialog.Close className="skill-dialog-close" aria-label="关闭保存弹窗" disabled={busy}><X size={16} aria-hidden /></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
