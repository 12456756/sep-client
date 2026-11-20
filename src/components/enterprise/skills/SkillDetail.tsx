import { ArrowLeft, Check, FileText, PanelRightOpen, Pencil, RefreshCw, Save, Trash2, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { EnterpriseWorkspace } from '../../../features/enterprise/useEnterpriseWorkspace';
import type { AppRoute } from '../../../features/enterprise/types';
import { buildSkillVersions, findSkillVersion, initialSkillViewingVersion, skillDateLabel, skillReadingParts } from '../../../features/enterprise/skill-version-model';
import type { SkillVersionEntry } from '../../../features/enterprise/skill-version-model';
import { uniqueSkillBindings } from '../../../features/enterprise/skill-list-model';
import type { SkillLibraryItem } from '../../../shared/skill-library';
import { hasPersonalSkillVersionName, SKILL_VERSION_NAME_TAKEN } from '../../../shared/skill-library';
import { SkillRewriteComposer } from './SkillRewriteComposer';
import { useFeedback } from '../../feedback/FeedbackProvider';
import { changeSkillDraft, createSkillDraftHistory, resetSkillDraft, undoSkillDraft } from '../../../features/enterprise/skill-draft-history';
import type { SkillEditDraft } from '../../../features/enterprise/skill-rewrite-session';
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
  const feedback = useFeedback();
  const rewriteSession = workspace.getSkillRewriteSession(skill.capability.id);
  const rewriteState = useSyncExternalStore(rewriteSession.subscribe, rewriteSession.getSnapshot, rewriteSession.getSnapshot);
  const entries = useMemo(() => buildSkillVersions(skill), [skill]);
  const bindings = uniqueSkillBindings(skill);
  const [viewingVersionId, setViewingVersionId] = useState(() => rewriteSession.draft?.viewingVersionId ?? initialSkillViewingVersion(skill, sourceEmployeeId));
  const [tab, setTab] = useState<'description' | 'history'>('description');
  const [mode, setMode] = useState<'read' | 'raw'>('read');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [chatRevision, setChatRevision] = useState(0);
  const [container, setContainer] = useState<HTMLElement>();
  const [source, setSource] = useState(() => rewriteSession.draft?.source ?? '');
  const [draftState, setDraftState] = useState(() => rewriteSession.draft?.draftState ?? createSkillDraftHistory());
  const { content } = draftState;
  const rewriteBusy = Boolean(rewriteState.activeRequestId);
  const draft = useRef(draftState);
  const manualEdit = useRef<string | null>(null);
  const updateContent = useCallback((value: string): void => {
    draft.current = resetSkillDraft(draft.current, value);
    manualEdit.current = null;
    setDraftState(draft.current);
  }, []);
  const [editing, setEditing] = useState(() => rewriteSession.draft?.editing ?? false);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<Operation>(null);
  const [deleting, setDeleting] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [actionError, setActionError] = useState<{ message: string; phase: Exclude<Operation, null>; key?: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [savedId, setSavedId] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState(() => rewriteSession.draft?.name ?? '');
  const [reload, setReload] = useState(0);
  const sourceCache = useRef(new Map<string, string>());
  const saveAttempt = useRef<{ key: string; signature: string } | null>(null);
  const duplicateName = hasPersonalSkillVersionName(skill, name, saveAttempt.current?.key);
  const editor = useRef<HTMLTextAreaElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const sourceTrigger = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const busy = operation !== null || deleting;
  const dirty = editing && content !== source;
  const entry = findSkillVersion(entries, viewingVersionId);
  const parentVersionId = entry?.parentVersionId;
  const validParent = Boolean(parentVersionId && skill.versions.some(version => version.id === parentVersionId));
  const retrySeconds = workspace.skillsRetrySeconds ?? 0;
  const canRefresh = !workspace.skillsLoading && !busy && !dirty && retrySeconds <= 0;
  const { previewSkillSource, registerSkillLeaveGuard } = workspace;
  const snapshot = useRef<SkillEditDraft>();
  const restored = useRef(rewriteSession.draft);
  useLayoutEffect(() => {
    snapshot.current = { viewingVersionId, source, draftState, editing, name };
    if (!loading && !sourceError) rewriteSession.draft = snapshot.current;
  }, [rewriteSession, viewingVersionId, source, draftState, editing, name, loading, sourceError]);

  useLayoutEffect(() => { setContainer(page.current?.closest<HTMLElement>('.ent-shell') ?? undefined); }, []);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    if (restored.current?.viewingVersionId === viewingVersionId && reload === 0) {
      sourceCache.current.set(viewingVersionId, restored.current.source);
      setLoading(false);
      return;
    }
    restored.current = undefined;
    setLoading(true); setSourceError(''); setSource(''); updateContent('');
    if (!viewingVersionId) { setLoading(false); return; }
    const cached = sourceCache.current.get(viewingVersionId);
    if (cached !== undefined) { setSource(cached); updateContent(cached); setLoading(false); return; }
    void previewSkillSource(skill.capability.id, viewingVersionId).then(text => {
      if (active) { sourceCache.current.set(viewingVersionId, text); setSource(text); updateContent(text); }
    }).catch(cause => { if (active) setSourceError(cause instanceof Error ? cause.message : '读取失败'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [skill.capability.id, viewingVersionId, previewSkillSource, reload, updateContent]);

  useEffect(() => {
    if (workspace.skillsLoading || workspace.skillsError || entry || editing || rewriteBusy || dirty || busy) return;
    const fallback = initialSkillViewingVersion(skill, sourceEmployeeId);
    if (fallback !== viewingVersionId) { setEditing(false); setViewingVersionId(fallback); setNotice('原查看版本已不在当前列表中，已更新查看内容。'); }
  }, [workspace.skillsLoading, workspace.skillsError, entry, editing, rewriteBusy, dirty, busy, skill, sourceEmployeeId, viewingVersionId]);
  useEffect(() => { if (sourceOpen && mode === 'raw') editor.current?.focus(); }, [editing, sourceOpen, mode]);
  useEffect(() => {
    if (!dirty && !busy && !rewriteBusy) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, busy, rewriteBusy]);
  useLayoutEffect(() => registerSkillLeaveGuard?.(() => {
    if (busy) return false;
    if (snapshot.current && !loading && !sourceError) rewriteSession.draft = snapshot.current;
    if (rewriteSession.finishUnchangedEditing()) setEditing(false);
    return true;
  }), [registerSkillLeaveGuard, busy, rewriteSession, loading, sourceError]);

  const mayDiscard = (): boolean => !busy && (!(dirty || rewriteBusy) || window.confirm('有未保存修改或正在生成的建议，确定放弃吗？'));
  const discard = async (): Promise<void> => {
    if (!mayDiscard() || !await rewriteSession.cancel(workspace.cancelSkillRewrite)) return;
    rewriteSession.reset();
    updateContent(source); setEditing(false); setSourceOpen(false); setMode('read'); setActionError(null); setChatRevision(value => value + 1);
  };
  const view = async (id: string): Promise<void> => {
    if (id === viewingVersionId) { setTab('description'); return; }
    if (!mayDiscard()) return;
    const next = findSkillVersion(entries, id);
    if (!next) return;
    if (!await rewriteSession.cancel(workspace.cancelSkillRewrite)) return;
    rewriteSession.reset();
    setEditing(false); setSourceOpen(false); setMode('read'); setViewingVersionId(next.id); setTab('description'); setNotice(''); setSourceError('');
  };
  const back = (): void => {
    if (busy) return;
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
    if (busy || rewriteBusy || duplicateName || !name.trim() || !content.trim() || !validParent || !parentVersionId || !dirty) return;
    const request = { capabilityId: skill.capability.id, parentVersionId, content, changeSummary: name.trim() };
    const signature = JSON.stringify(request);
    if (saveAttempt.current?.signature !== signature) saveAttempt.current = { key: crypto.randomUUID(), signature };
    setOperation('save'); setActionError(null);
    try {
      const result = await workspace.saveSkillSource(request, saveAttempt.current.key);
      if (!alive.current) return;
      sourceCache.current.set(result.idempotencyKey, content);
      saveAttempt.current = null;
      updateContent(content);
      setSaveOpen(false); setEditing(false); setSourceOpen(false); setMode('read'); setSource(content); setName(''); setSavedId(result.idempotencyKey);
      rewriteSession.reset();
      setViewingVersionId(result.idempotencyKey);
      setNotice(result.uploaded ? '个人版本已保存并启用，已上传送审。' : '个人版本已保存到本机并启用，上传未成功。');
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
  const deleteVersion = async (target: SkillVersionEntry): Promise<void> => {
    const idempotencyKey = target.local?.idempotencyKey;
    if (!idempotencyKey || editing || busy) return;
    const revision = feedback.getRevision();
    const isCurrent = (): boolean => alive.current && revision === feedback.getRevision();
    await feedback.confirm({
      key: JSON.stringify(['delete-skill-version', workspace.attachmentScopeKey, skill.capability.id, target.id]),
      title: '删除本地副本',
      message: `确认删除「${target.label}」在此设备上的副本？本地副本无法恢复，已上传的版本和审核状态不受影响。${skill.bindings.some(binding => binding.selectedVersionId === idempotencyKey) ? '此设备上选用该副本的员工将改用默认版本。' : ''}`,
      actionLabel: '删除本地副本', busyLabel: '正在删除…',
      onConfirm: async () => {
        if (!isCurrent()) return { success: true };
        setDeleting(true);
        try {
          const updated = await workspace.deleteLocalSkillCopy(skill.capability.id, idempotencyKey);
          if (isCurrent()) {
            target.aliases.forEach(id => sourceCache.current.delete(id));
            if (target.aliases.includes(viewingVersionId)) {
              rewriteSession.reset();
              restored.current = undefined;
              setLoading(true); setSourceError(''); setSource(''); updateContent('');
              const fallback = initialSkillViewingVersion(updated, sourceEmployeeId);
              setViewingVersionId(fallback);
              if (fallback === viewingVersionId) setReload(value => value + 1);
              setMode('read'); setName(''); setSavedId('');
              saveAttempt.current = null;
            }
            setActionError(current => current?.key === idempotencyKey ? null : current);
            setNotice('本地副本已删除。');
          }
          return { success: true };
        } catch (error) {
          return { success: false, message: error instanceof Error ? error.message : '删除本地副本失败，请重试。' };
        } finally {
          if (isCurrent()) setDeleting(false);
        }
      },
    });
  };
  const deleteButton = (target: SkillVersionEntry | undefined, compact = false): React.JSX.Element | null => {
    if (!target?.local) return null;
    return <button type="button" className={`ent-btn danger ghost${compact ? ' sm' : ''}`} aria-label={`删除本地副本：${target.label}`} disabled={busy || editing} onClick={() => void deleteVersion(target)}><Trash2 size={14} aria-hidden />删除本地副本</button>;
  };

  return <div ref={page} className={`ent-page skill-detail${editing ? ' skill-detail-editing' : ''}`}>
    <div className="skill-detail-navigation"><button type="button" className="skill-text-button skill-detail-back" disabled={busy} onClick={back}><ArrowLeft size={18} aria-hidden />{returnLabel}</button>{returnTo?.name === 'employee' ? <button type="button" className="skill-text-button" disabled={busy} onClick={() => workspace.navigate({ name: 'skills' })}>全部技能</button> : null}</div>
    <header className="skill-detail-heading"><h1>{skill.capability.name || '未命名技能'}</h1></header>
    {notice ? <div className="ent-banner info skill-detail-notice" role="status"><span>{notice}</span>{savedId ? <button type="button" className="ent-btn sm" disabled={busy} onClick={returnToList}>返回技能列表</button> : null}</div> : null}
    {workspace.skillsWarning ? <p className="skill-caption" role="status">{workspace.skillsWarning}</p> : null}
    {workspace.skillsError ? <div className="ent-banner danger skill-state-banner" role="alert"><span>{workspace.skillsError}</span><button type="button" className="ent-btn sm" disabled={!canRefresh} onClick={() => void workspace.refreshSkills(true, skill.capability.id)}>{retrySeconds > 0 ? `${retrySeconds} 秒后重试` : '重试刷新'}</button></div> : null}
    {actionError && !(saveOpen && actionError.phase === 'save') ? <div className="ent-banner danger skill-state-banner" role="alert"><span>{actionError.message}</span>{actionError.phase === 'upload' ? <button type="button" className="ent-btn sm" disabled={busy || dirty} onClick={() => void retryUpload(actionError.key!)}>重试上传</button> : <button type="button" className="ent-btn sm" disabled={busy} onClick={() => setSaveOpen(true)}>重试保存</button>}</div> : null}
    <div className="skill-detail-tabs" role="tablist" aria-label="技能详情">{(['description', 'history'] as const).map(item => <button type="button" key={item} role="tab" id={`skill-tab-${item}`} aria-selected={tab === item} aria-controls={`skill-panel-${item}`} tabIndex={tab === item ? 0 : -1} disabled={busy || dirty && item === 'history'} onKeyDown={setTabFromKey} onClick={() => setTab(item)}>{item === 'description' ? '技能说明' : '版本记录'}</button>)}</div>
    <section className={editing ? 'skill-chat-panel' : undefined} id="skill-panel-description" role="tabpanel" aria-labelledby="skill-tab-description" hidden={tab !== 'description'}>
      <div className="skill-content-toolbar"><div className="skill-inline-actions"><span className="skill-viewing-version">{entry ? entry.label : viewingVersionId ? '查看版本已不可用，草稿已保留' : '暂无版本'}</span>{editing ? <span className="skill-badge">个人版本草稿</span> : null}</div><div className="skill-inline-actions">{editing ? <button ref={sourceTrigger} type="button" className="skill-text-button" disabled={loading || Boolean(sourceError) || !viewingVersionId || busy} onClick={() => { setMode('read'); setSourceOpen(true); }}><PanelRightOpen size={15} aria-hidden />查看原文</button> : <><div className="ent-segment"><button type="button" aria-pressed={mode === 'read'} className={mode === 'read' ? 'active' : undefined} onClick={() => setMode('read')}>阅读</button><button type="button" aria-pressed={mode === 'raw'} className={mode === 'raw' ? 'active' : undefined} onClick={() => setMode('raw')}>原文</button></div>{deleteButton(entry)}<button type="button" className="ent-btn" disabled={!entry || !validParent || loading || busy || Boolean(sourceError)} onClick={() => { setMode('read'); setEditing(true); setActionError(null); }}><Pencil size={14} aria-hidden />创建个人版本</button></>}</div></div>
      {sourceError ? <div className="ent-banner danger skill-state-banner" role="alert"><span>{sourceError}</span><button type="button" className="ent-btn sm" disabled={busy} onClick={() => { sourceCache.current.delete(viewingVersionId); setReload(value => value + 1); }}>重新读取</button></div> : null}
      {loading ? <p className="skill-loading" role="status">正在读取原文…</p> : !viewingVersionId ? <div className="skill-document-empty">当前技能暂无可查看的版本。</div> : !sourceError ? editing ? <SkillRewriteComposer key={`${viewingVersionId}-${chatRevision}`} content={content} revision={draft.current.revision} disabled={busy || !validParent || saveOpen}
        onRewrite={input => workspace.rewriteSkillSource({ ...input, capabilityId: skill.capability.id, versionId: viewingVersionId })}
        session={rewriteSession}
        onCancel={workspace.cancelSkillRewrite}
        undoHead={draftState.changes.at(-1)}
        manualEdits={draftState.manualEdits}
        onApply={(expectedRevision, next, roundId) => {
          if (busy || saveOpen || sourceOpen) return false;
          const updated = changeSkillDraft(draft.current, expectedRevision, roundId, 'rewrite', next);
          if (updated === draft.current) return false;
          draft.current = updated; setDraftState(updated); return true;
        }}
        onUndo={id => {
          if (busy || saveOpen || sourceOpen || rewriteBusy) return false;
          const updated = undoSkillDraft(draft.current, id);
          if (updated === draft.current) return false;
          draft.current = updated; setDraftState(updated); return true;
        }}
      /> : <div className="skill-document">{mode === 'raw' ? <textarea className="skill-source" aria-label="Skill 原始内容" value={content} readOnly spellCheck={false} /> : content.length ? <div className="skill-reading"><Markdown skipHtml remarkPlugins={[remarkGfm]} components={readingComponents}>{reading.body}</Markdown></div> : <p className="skill-document-empty">此版本内容为空。</p>}</div> : null}
      {editing ? <footer className="skill-editor-footer"><span className="skill-chat-save-state">{dirty ? '原文有未保存修改' : '个人版本草稿'}</span><div className="skill-inline-actions"><button type="button" className="ent-btn" disabled={busy} onClick={() => void discard()}>取消修改</button><button type="button" className="ent-btn primary" disabled={busy || rewriteBusy || !content.trim() || !dirty || !validParent} onClick={() => setSaveOpen(true)}><Save size={14} aria-hidden />保存为个人版本</button></div></footer> : null}
      {editing && !validParent ? <p className="skill-error" role="alert">来源版本已不可用，草稿仍保留，当前无法保存。请核对技能状态后重试。</p> : null}
    </section>
    <section className="skill-history" id="skill-panel-history" role="tabpanel" aria-labelledby="skill-tab-history" hidden={tab !== 'history'}>
      <div className="skill-history-toolbar"><button type="button" className="skill-text-button" disabled={!canRefresh} onClick={() => void workspace.refreshSkills(true, skill.capability.id)}><RefreshCw size={13} aria-hidden />{workspace.skillsLoading ? '刷新中…' : retrySeconds > 0 ? `${retrySeconds} 秒后重试` : '刷新状态'}</button></div>
      {entries.length ? entries.map(item => <div className={`skill-version-row${entry?.id === item.id ? ' active' : ''}`} key={item.id}><FileText size={19} aria-hidden /><div className="skill-version-info"><strong>{item.label}{item.local || item.version?.scope === 'PERSONAL' ? <span className="skill-badge">个人</span> : null}</strong><small>{item.status} · {skillDateLabel(item.createdAt)}</small>{item.version?.rejectionReason ? <small className="skill-error">驳回原因：{item.version.rejectionReason}</small> : null}{item.usedBy.length ? <details className="skill-version-used"><summary><Check size={12} aria-hidden />{item.usedBy.length === bindings.length ? `全部 ${bindings.length} 名员工使用` : `${item.usedBy.length} / ${bindings.length} 名员工使用`}</summary><p>{item.usedBy.map(employeeName).join('、')}</p></details> : null}</div>{deleteButton(item, true)}<button type="button" className="ent-btn sm" disabled={busy} onClick={() => view(item.id)}>{entry?.id === item.id ? '正在查看' : '查看内容'}</button>{item.local && !item.local.uploadedVersion ? <button type="button" className="ent-btn sm" disabled={busy || dirty} onClick={() => void retryUpload(item.id)}>{operation === 'upload' ? '正在上传…' : '重试上传'}</button> : null}</div>) : <p className="skill-document-empty">当前技能暂无可查看的版本。</p>}
    </section>
    <Dialog.Root open={sourceOpen && editing} onOpenChange={open => { if (!busy) { if (!open) manualEdit.current = null; setSourceOpen(open); } }}><Dialog.Portal container={container}>
      <Dialog.Overlay className="skill-dialog-overlay skill-source-overlay" />
      <Dialog.Content className="skill-source-drawer" onOpenAutoFocus={event => { if (mode === 'raw') { event.preventDefault(); editor.current?.focus(); } }} onCloseAutoFocus={event => { event.preventDefault(); sourceTrigger.current?.focus(); }} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
        <header className="skill-source-drawer-heading"><Dialog.Close className="skill-rewrite-icon skill-source-back" aria-label="关闭原文" title="返回对话" disabled={busy}><ArrowLeft size={18} aria-hidden /></Dialog.Close><div><Dialog.Title>技能原文</Dialog.Title><Dialog.Description>{skill.capability.name} · {entry?.label || '暂无版本'}</Dialog.Description></div></header>
        <div className="skill-source-drawer-toolbar"><div className="ent-segment"><button type="button" aria-pressed={mode === 'read'} className={mode === 'read' ? 'active' : undefined} onClick={() => setMode('read')}>阅读</button><button type="button" aria-pressed={mode === 'raw'} className={mode === 'raw' ? 'active' : undefined} onClick={() => setMode('raw')}>原文</button></div>{mode === 'read' || !editing ? <button type="button" className="skill-text-button" disabled={busy || !validParent} onClick={() => { setEditing(true); setMode('raw'); setActionError(null); }}><Pencil size={14} aria-hidden />编辑原文</button> : <span className="skill-badge">编辑中</span>}</div>
        <div className="skill-source-drawer-body">{mode === 'raw' ? <textarea ref={editor} className={`skill-source${editing ? ' editing' : ''}`} aria-label="Skill 原始内容" value={content} readOnly={!editing || busy} spellCheck={false} onChange={event => {
          manualEdit.current ??= crypto.randomUUID();
          draft.current = changeSkillDraft(draft.current, draft.current.revision, manualEdit.current, 'manual', event.target.value);
          setDraftState(draft.current);
        }} /> : content.length ? <div className="skill-reading"><Markdown skipHtml remarkPlugins={[remarkGfm]} components={readingComponents}>{reading.body}</Markdown></div> : <p className="skill-document-empty">此版本内容为空。</p>}</div>
        <footer className="skill-source-drawer-footer"><span>{dirty ? '有未保存修改' : '原文未修改'}</span><Dialog.Close asChild><button type="button" className="ent-btn" disabled={busy}>返回对话</button></Dialog.Close></footer>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>
    <Dialog.Root open={saveOpen} onOpenChange={open => { if (!busy) setSaveOpen(open); }}><Dialog.Portal container={container}><Dialog.Overlay className="skill-dialog-overlay" /><Dialog.Content className="skill-save-dialog"><Dialog.Title>保存为个人版本</Dialog.Title><Dialog.Description>保存后自动启用新版本，应用于全部关联员工，并上传送审。</Dialog.Description><label className="ent-field"><span>版本名称 / 修改说明</span><input className="ent-input" value={name} onChange={event => setName(event.target.value)} placeholder="例如：我的优化版" disabled={busy} aria-invalid={duplicateName || undefined} aria-describedby={duplicateName ? 'skill-version-name-error' : undefined} /></label>{duplicateName ? <p id="skill-version-name-error" role="alert" className="skill-error">{SKILL_VERSION_NAME_TAKEN}</p> : actionError?.phase === 'save' ? <p role="alert" className="skill-error">{actionError.message}</p> : null}<footer><Dialog.Close asChild><button type="button" className="ent-btn" disabled={busy}>取消</button></Dialog.Close><button type="button" className="ent-btn primary" disabled={busy || duplicateName || !name.trim() || !content.trim() || !validParent} onClick={() => void save()}>{operation === 'save' ? '正在保存并上传…' : '确定保存'}</button></footer><Dialog.Close className="skill-dialog-close" aria-label="关闭保存弹窗" disabled={busy}><X size={16} aria-hidden /></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
