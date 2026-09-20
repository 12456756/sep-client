import { ArrowLeft, Check, FileText, History, Info, Pencil, RefreshCw, Save, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import type { EnterpriseWorkspace } from '../../../features/enterprise/useEnterpriseWorkspace';
import { localSkillVersionStatus, selectedSkillVersion, skillVersionLabel, skillVersionStatus } from '../../../features/enterprise/skill-labels';
import type { SkillLibraryItem } from '../../../shared/skill-library';

interface Props { workspace: EnterpriseWorkspace; skill: SkillLibraryItem }
export function SkillDetail({ workspace, skill }: Props) {
  const [versionId, setVersionId] = useState(selectedSkillVersion(skill) || skill.bindings[0]?.currentVersion.id || '');
  const [source, setSource] = useState('');
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState('');
  const [reload, setReload] = useState(0);
  const savedSources = useRef(new Map<string, string>());
  const saveAttempt = useRef<{ key: string; signature: string } | null>(null);
  const history = useRef<HTMLElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const { previewSkillSource } = workspace;
  const version = skill.versions.find(item => item.id === versionId);
  const local = skill.localVersions.find(item => item.idempotencyKey === versionId);
  const title = version ? skillVersionLabel(version) : local?.request.changeSummary || '个人修改版';
  const dirty = editing && content !== source;
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setEditing(false); setSource(''); setContent('');
    const saved = savedSources.current.get(versionId);
    if (saved !== undefined) { setSource(saved); setContent(saved); setLoading(false); return; }
    void previewSkillSource(skill.capability.id, versionId).then(text => {
      if (active) { setSource(text); setContent(text); }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '读取失败'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [skill.capability.id, versionId, previewSkillSource, reload]);
  useEffect(() => { if (editing) editor.current?.focus(); }, [editing]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  const mayLeave = (): boolean => !dirty || window.confirm('有尚未保存的修改，确定放弃吗？');
  const save = async (): Promise<void> => {
    if (busy || !name.trim() || !content.length) return;
    const parentVersionId = version?.id ?? local?.uploadedVersion?.id ?? local?.request.parentVersionId;
    if (!parentVersionId) return;
    const request = { capabilityId: skill.capability.id, parentVersionId, content, changeSummary: name.trim() };
    const signature = JSON.stringify(request);
    if (saveAttempt.current?.signature !== signature) saveAttempt.current = { key: crypto.randomUUID(), signature };
    setBusy(true); setError('');
    try {
      const result = await workspace.saveSkillSource(request, saveAttempt.current.key);
      saveAttempt.current = null;
      setSaveOpen(false); setEditing(false); setSource(content); setName('');
      setNotice(result.uploaded ? '已保存个人版本并上传送审。无需等待审核，可返回列表切换为本人本地使用。' : '已保存到本机，可返回列表切换使用；上传未成功，可在下方重试，不会丢失原文。');
      const savedId = result.idempotencyKey;
      savedSources.current.set(savedId, content);
      setVersionId(savedId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试'); }
    finally { setBusy(false); }
  };
  const retryUpload = async (key: string): Promise<void> => {
    setBusy(true); setError('');
    try {
      const result = await workspace.retrySkillUpload(skill.capability.id, key);
      setNotice(result.uploaded ? '上传成功，已进入审核；不影响本人本地使用。' : '上传仍未成功，原文已保存在本机，可由本人本地使用。');
      // Uploading does not change which local source is being viewed or used.
    } catch (cause) { setError(cause instanceof Error ? cause.message : '上传失败'); }
    finally { setBusy(false); }
  };
  const view = (id: string): void => { if (mayLeave()) { setEditing(false); setContent(source); setVersionId(id); setNotice(''); } };
  return <div className="ent-page skill-detail">
    <div className="skill-detail-heading"><button className="ent-icon-btn" aria-label="返回技能列表" disabled={busy} onClick={() => { if (mayLeave()) workspace.navigate({ name: 'skills' }); }}><ArrowLeft size={18} /></button><div><h1>{skill.capability.name}</h1><p>{skill.capability.description}</p></div><button className="ent-btn" onClick={() => history.current?.scrollIntoView({ behavior: 'auto', block: 'start' })}><History size={15} />版本历史</button></div>
    <div className="ent-banner info"><Info size={16} aria-hidden /><span>正在查看 {title}。修改将保存为新的个人版本并上传审核，不会覆盖原发布版，也不会自动切换使用版本。</span></div>
    {notice ? <div className="ent-banner info" role="status">{notice}</div> : null}
    {error && !saveOpen ? <div className="ent-banner danger" role="alert">{error}<button className="ent-btn" onClick={() => setReload(value => value + 1)}>重新读取</button></div> : null}
    <section className="skill-editor-panel">
      <header><h2><FileText size={17} aria-hidden />技能原文 <span>SKILL.md</span></h2><button className="ent-btn" disabled={loading || busy || Boolean(error)} onClick={() => setEditing(true)}><Pencil size={14} aria-hidden />{editing ? '修改中' : '修改'}</button></header>
      {loading ? <p role="status">正在读取原文…</p> : <textarea ref={editor} className={`skill-source${editing ? ' editing' : ''}`} aria-label="Skill 原始内容" value={content} readOnly={!editing || busy} maxLength={500000} spellCheck={false} onChange={event => setContent(event.target.value)} />}
      <footer><span className="skill-caption">{content.length.toLocaleString()} 字符 · 保留 Markdown 与 frontmatter 原文</span>{editing ? <div><button className="ent-btn" disabled={busy} onClick={() => { if (mayLeave()) { setContent(source); setEditing(false); } }}>取消修改</button><button className="ent-btn primary" disabled={busy || !content.length || !dirty} onClick={() => setSaveOpen(true)}><Save size={14} />保存为个人版本</button></div> : <span className="skill-caption">只读浏览 · 点击「修改」直接编辑原文</span>}</footer>
    </section>
    <section className="skill-history" ref={history}><header><div><h2>版本列表</h2><p>本地修改无需等待审核，可返回列表切换使用；企业发布版本保持不变。</p></div><button className="ent-btn" disabled={workspace.skillsLoading || busy} onClick={() => void workspace.refreshSkills()}><RefreshCw size={14} />刷新审核状态</button></header>
      {workspace.skillsError ? <p role="alert" className="skill-error">{workspace.skillsError}</p> : null}
      {skill.versions.map(item => <div className={`skill-version-row${versionId === item.id ? ' active' : ''}`} key={item.id}>
        <div className="skill-version-icon"><FileText size={20} /></div><div className="skill-version-info"><strong title={item.version}>{skillVersionLabel(item)} <span className="skill-badge">{item.scope === 'PERSONAL' ? '个人' : item.scope === 'ENTERPRISE' ? '企业' : '平台'}</span></strong><small>{skillVersionStatus(item.status)}{item.createdAt ? ` · ${new Date(item.createdAt).toLocaleString()}` : ''}</small>{item.rejectionReason ? <small className="skill-error">驳回原因：{item.rejectionReason}</small> : null}</div>
        {skill.bindings.some(binding => binding.selectedVersionId === item.id) ? <span className="skill-current"><Check size={13} />使用中</span> : null}
        <button className="ent-btn" disabled={busy} onClick={() => view(item.id)}>{versionId === item.id ? '正在查看' : '查看原文'}</button>
      </div>)}
      {skill.localVersions.map(item => <div className={`skill-version-row${versionId === item.idempotencyKey ? ' active' : ''}`} key={item.idempotencyKey}><div className="skill-version-icon"><FileText size={20} /></div><div className="skill-version-info"><strong>{item.request.changeSummary || '个人修改版'}</strong><small>{localSkillVersionStatus(skill, item)} · {new Date(item.createdAt).toLocaleString()}</small></div>{skill.bindings.some(binding => binding.selectedVersionId === item.idempotencyKey) ? <span className="skill-current"><Check size={13} />使用中</span> : null}<button className="ent-btn" disabled={busy} onClick={() => view(item.idempotencyKey)}>查看原文</button>{!item.uploadedVersion ? <button className="ent-btn" disabled={busy} onClick={() => void retryUpload(item.idempotencyKey)}>重试上传</button> : null}</div>)}
    </section>
    <Dialog.Root open={saveOpen} onOpenChange={open => { if (!busy) setSaveOpen(open); }}><Dialog.Portal><Dialog.Overlay className="skill-dialog-overlay" /><Dialog.Content className="skill-save-dialog"><Dialog.Title>保存为个人版本</Dialog.Title><Dialog.Description>保存完整原文到本机，同时上传 SEP 平台送审。企业发布版本保持不变。</Dialog.Description><label className="ent-field"><span>版本名称 / 修改说明</span><input className="ent-input" value={name} maxLength={2000} onChange={event => setName(event.target.value)} placeholder="例如：我的优化版" disabled={busy} /></label>{error ? <p role="alert" className="skill-error">{error}</p> : null}<footer><Dialog.Close asChild><button className="ent-btn" disabled={busy}>取消</button></Dialog.Close><button className="ent-btn primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? '正在保存并上传…' : '确定保存'}</button></footer><Dialog.Close className="skill-dialog-close" aria-label="关闭保存弹窗" disabled={busy}><X size={16} /></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
