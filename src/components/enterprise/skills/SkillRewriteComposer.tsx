import { ArrowUp, Check, ClipboardList, FileText, GitCompareArrows, ListChecks, LoaderCircle, MessageSquare, Pencil, RefreshCw, ShieldCheck, Sparkles, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { IconHint } from '../IconHint';
import { ModelSelector } from '../ModelSelector';
import { ComposerResizeHandle } from '../ComposerResizeHandle';
import { useModelCatalog } from '../ModelCatalogContext';
import { useModelPreference } from '../../workspace/model-preference-scope';
import { resolveTaskModel } from '../../../shared/model-preferences';
import { isSubmitEnter } from '../../../shared/composer-shortcut';
import type { SkillRewriteInput, SkillRewriteResult } from '../../../shared/skill-rewrite';
import { SkillRewriteComparison } from './SkillRewriteComparison';
import type { SkillDraftChange, SkillManualEdit } from '../../../features/enterprise/skill-draft-history';
import { SkillEditRecord } from './SkillEditRecord';
import type { AdjustmentRecord, RewriteRound, SkillRewriteSession } from '../../../features/enterprise/skill-rewrite-session';
import { effectiveRewriteStatus } from '../../../features/enterprise/skill-rewrite-session';
import { FileMentionChips, FileMentionPicker } from '../attachments/FileMentionPicker';
import { FileMentionEditor } from '../attachments/FileMentionEditor';
import { AttachmentDropZone } from '../attachments/AttachmentDropZone';
import { useTextReferenceComposer } from '../attachments/use-text-reference-composer';

interface Props {
  content: string;
  revision: number;
  disabled: boolean;
  onRewrite(input: Omit<SkillRewriteInput, 'capabilityId' | 'versionId'>): Promise<SkillRewriteResult>;
  onCancel(requestId: string): Promise<void>;
  onApply(expectedRevision: number, content: string, roundId: string): boolean;
  undoHead?: Pick<SkillDraftChange, 'id' | 'kind'>;
  manualEdits: readonly SkillManualEdit[];
  onUndo(id: string): boolean;
  session: SkillRewriteSession;
}

const shortcuts = [
  { label: '补充要求', icon: ShieldCheck, prompt: '请补充以下工作要求：' },
  { label: '调整流程', icon: ListChecks, prompt: '我想调整工作流程：' },
  { label: '修改输出', icon: ClipboardList, prompt: '请把交付结果调整为：' },
];
const statusLabels = {
  accepted: '已采纳到草稿', ignored: '已忽略本轮建议', superseded: '已继续调整，以后续预览为准',
  undone: '已撤销本轮采纳', stale: '草稿已更新，请基于当前内容重新生成', cancelled: '已停止生成',
};
const changeLabels = { add: '新增', change: '调整', remove: '删除' };
export function SkillRewriteComposer({ content, revision, disabled, onRewrite, onCancel, onApply, undoHead, manualEdits, onUndo, session }: Props): React.JSX.Element {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const { prompt, rounds, modelId, cancelError } = state;
  const generating = Boolean(state.activeRequestId);
  const setRounds = (update: (rounds: AdjustmentRecord[]) => AdjustmentRecord[]): void => session.setRounds(update);
  const input = useRef<HTMLTextAreaElement>(null);
  const files = useTextReferenceComposer({ input, value: prompt, update: value => session.update({ prompt: value }), bindingKey: 'skill-rewrite', disabled: disabled || generating, retained: session.attachment });
  const { mention } = files;
  const composer = useRef<HTMLElement | null>(null);
  const setComposer = useCallback((element: HTMLElement | null) => { composer.current = element; }, []);
  const history = useRef<HTMLDivElement>(null);
  const catalog = useModelCatalog();
  const { defaultModelId } = useModelPreference();
  const models = catalog.models.map(model => model.modelId);
  const selectedModel = resolveTaskModel(models, defaultModelId, modelId);
  const latestRound = rounds.at(-1);
  const rewriteNumbers = new Map(rounds.filter(round => round.kind === 'rewrite').map((round, index) => [round.id, index + 1]));

  useEffect(() => {
    session.setRounds(current => {
      const edits = new Map(manualEdits.map(edit => [edit.id, edit]));
      const known = new Set(current.map(item => item.id));
      return [
        ...current.flatMap<AdjustmentRecord>(item => item.kind === 'rewrite' ? [item] : edits.has(item.id) ? [{ ...edits.get(item.id)!, kind: 'manual' as const }] : []),
        ...manualEdits.filter(edit => !known.has(edit.id)).map(edit => ({ ...edit, kind: 'manual' as const })),
      ];
    });
  }, [manualEdits, session]);
  useEffect(() => {
    const panel = history.current;
    const last = panel?.lastElementChild;
    if (panel && last) panel.scrollTop += last.getBoundingClientRect().top - panel.getBoundingClientRect().top;
  }, [latestRound?.id, latestRound?.status]);

  const preview = async (request = mention.submissionText, previousModelId?: string, previousFiles?: RewriteRound['referenceFiles']): Promise<void> => {
    const model = previousModelId && models.includes(previousModelId) ? previousModelId : selectedModel;
    if (disabled || generating || (!previousModelId && files.blocked) || !model || !request.trim() || request.trim().length > 8_000 || !content.trim()) return;
    const round: RewriteRound = { kind: 'rewrite', id: crypto.randomUUID(), prompt: request.trim(), source: content, revision, model, status: 'generating', referenceFiles: previousModelId ? previousFiles : files.referenceFiles };
    input.current?.focus();
    await session.generate(round, onRewrite);
  };
  const cancel = async (): Promise<void> => {
    await session.cancel(onCancel);
  };
  const accept = (round: RewriteRound): void => {
    if (disabled || generating || !round.result || effectiveRewriteStatus(round, revision) !== 'pending') return;
    if (!onApply(round.revision, round.result.content, round.id)) return;
    setRounds(current => current.map(item => item.kind === 'rewrite' && item.id === round.id ? { ...item, status: 'accepted' } : item));
    input.current?.focus();
  };
  const undo = (round: RewriteRound): void => {
    if (disabled || generating || undoHead?.id !== round.id || content !== round.result?.content) return;
    if (!onUndo(round.id)) return;
    setRounds(current => current.map(item => item.kind === 'rewrite' && item.id === round.id ? { ...item, status: 'undone' } : item));
  };

  return <section className="skill-rewrite skill-chat" aria-label="对话修改技能">
    <div className="skill-chat-meta"><span><MessageSquare size={14} aria-hidden />调整记录</span></div>
    <div ref={history} className={`skill-chat-history${rounds.length ? '' : ' is-empty'}`} role="region" aria-label="调整记录" tabIndex={0} aria-busy={generating}>
      {rounds.map(round => {
        if (round.kind === 'manual') {
          const canUndo = undoHead?.id === round.id;
          return <article className="skill-chat-round skill-chat-manual-record" key={round.id} aria-label="手动编辑记录">
            <div className="skill-chat-assistant-heading"><Pencil size={15} aria-hidden /><strong>手动编辑</strong></div>
            <SkillEditRecord label={round.status === 'applied' ? '已修改到草稿' : '已撤销手动编辑'} applied={round.status === 'applied'} canUndo={canUndo} disabled={disabled || generating}
              undoLabel="撤销手动编辑" undoHint={canUndo ? '撤销手动编辑' : '请先撤销后续修改'} onUndo={() => { onUndo(round.id); }} before={round.before} after={round.after} />
          </article>;
        }
        const number = rewriteNumbers.get(round.id)!;
        const status = effectiveRewriteStatus(round, revision);
        const canUndo = undoHead?.id === round.id && content === round.result?.content;
        const undoHint = canUndo ? '撤销本轮采纳' : undoHead?.kind === 'manual' ? '请先撤销手动编辑' : '请先撤销后续修改';
        return <article className="skill-chat-round" key={round.id} aria-label={`第 ${number} 轮调整`}>
          <div className="skill-chat-user"><span className="skill-chat-speaker">你</span><p>{round.prompt}</p></div>
          <div className="skill-chat-assistant"><div className="skill-chat-assistant-heading"><Sparkles size={15} aria-hidden /><strong>修改建议</strong><span>{round.model}</span></div>
            {status === 'generating' ? <p className="skill-chat-round-status" role="status"><LoaderCircle size={14} className="ent-spin" aria-hidden />正在生成修改建议…</p>
              : status === 'failed' ? <div className="skill-chat-round-status"><span className="skill-error" role="alert">{round.error}</span><button className="skill-text-button" type="button" disabled={disabled || generating} onClick={() => void preview(round.prompt, round.model, round.referenceFiles)}><RefreshCw size={13} aria-hidden />重试</button></div>
                : status === 'pending' && round.result ? <>
                  <p className="skill-chat-response">{round.result.summary}</p>
                  <section className="skill-rewrite-preview" aria-label={`第 ${number} 轮修改预览`}>
                    <header className="skill-rewrite-preview-heading"><div><GitCompareArrows size={15} aria-hidden /><h2>修改预览</h2></div><span className="skill-chat-pending">待确认</span></header>
                    <ul className="skill-chat-changes">{round.result.changes.map((change, changeIndex) => <li key={changeIndex}><span className="skill-chat-added">{changeLabels[change.kind]}</span><div><strong>{change.title}</strong><p>{change.detail}</p></div></li>)}</ul>
                    <SkillRewriteComparison before={round.source} after={round.result.content} />
                    <footer className="skill-rewrite-preview-footer"><p>{round.source === round.result.content ? '正文无需更改' : '待采纳'}</p><div><button type="button" className="ent-btn sm" disabled={disabled || generating} onClick={() => setRounds(current => current.map(item => item.kind === 'rewrite' && item.id === round.id ? { ...item, status: 'ignored' } : item))}><X size={13} aria-hidden />忽略</button><button type="button" className="ent-btn primary sm" disabled={disabled || generating || round.source === round.result.content} onClick={() => accept(round)}><Check size={13} aria-hidden />采纳修改</button></div></footer>
                  </section>
                </> : round.result && (status === 'accepted' || status === 'undone') ? <SkillEditRecord label={statusLabels[status]} applied={status === 'accepted'} canUndo={canUndo} disabled={disabled || generating}
                  undoLabel="撤销本轮采纳" undoHint={undoHint} onUndo={() => undo(round)} before={round.source} after={round.result.content} summary={round.result.summary} changes={round.result.changes} />
                  : <div className={`skill-chat-round-status is-${status}`} role="status"><span>{statusLabels[status as keyof typeof statusLabels]}</span>{status === 'stale' || status === 'cancelled' ? <button className="skill-text-button" type="button" disabled={disabled || generating} onClick={() => void preview(round.prompt, round.model, round.referenceFiles)}><RefreshCw size={13} aria-hidden />重新生成</button> : null}</div>}
          </div>
        </article>;
      })}
    </div>
    <div className="skill-chat-input-area">
      {catalog.error ? <p className="skill-error" role="alert">{catalog.error}{catalog.retry ? <button className="skill-text-button" type="button" onClick={catalog.retry}>重试</button> : null}</p> : !models.length ? <p className="skill-caption" role="status">暂无可用模型</p> : null}
      {cancelError ? <p className="skill-error" role="alert">{cancelError}</p> : null}
      <div className="skill-rewrite-shortcuts" aria-label="快捷调整要求">{shortcuts.map(item => <button type="button" key={item.label} disabled={disabled} onClick={() => { session.update({ prompt: item.prompt }); input.current?.focus(); }}><item.icon size={13} aria-hidden />{item.label}</button>)}</div>
      {files.error && <p className="skill-error" role="alert">{files.error}</p>}
      <AttachmentDropZone surfaceRef={setComposer} className="skill-rewrite-composer" composerId={files.composerId} disabled={files.dropDisabled}>
        <div className="skill-rewrite-input">
          <div className="skill-rewrite-references">
            {mention.unreferencedAttachments.length > 0 && <div className="ent-file-mention-chips" aria-label="已添加附件">
              {mention.unreferencedAttachments.map(item => <span key={item.attachmentId} className="ent-file-mention-chip">
                <button type="button" title={item.displayName} aria-label={`移除 ${item.displayName}`} disabled={files.dropDisabled} onClick={() => void files.removeAttachment(item.attachmentId)}>
                  <FileText size={12} aria-hidden /><span>{item.displayName}</span><X size={12} aria-hidden />
                </button>
              </span>)}
            </div>}
            <FileMentionChips mention={mention} />
          </div>
          <FileMentionEditor mention={mention} ref={input} {...mention.editorAria} value={prompt} rows={1} maxLength={8_000} aria-label="技能调整要求" placeholder="描述你的调整要求…" disabled={disabled} onChange={event => mention.change(event.currentTarget, (event.nativeEvent as InputEvent).inputType)} onCompositionStart={mention.compositionStart} onCompositionEnd={event => mention.compositionEnd(event.currentTarget)} onKeyDown={event => { mention.keyDown(event); if (isSubmitEnter(event, event.nativeEvent.isComposing)) { event.preventDefault(); void preview(); } }} />
        </div>
        <div className="skill-rewrite-tools">
          <FileMentionPicker mention={mention} />
          <div className="skill-rewrite-model"><ModelSelector models={models} value={selectedModel} title={selectedModel || '模型'} allowEmpty={false} disabled={disabled || generating} onChange={modelId => session.update({ modelId })} /></div>
          {generating ? <IconHint label="停止生成" side="top"><button type="button" className="skill-rewrite-send" aria-label="停止生成" onClick={() => void cancel()}><Square size={14} aria-hidden /></button></IconHint> : <IconHint label="发送调整要求" side="top"><button type="button" className="skill-rewrite-send" aria-label="发送调整要求" disabled={disabled || files.blocked || !selectedModel || !prompt.trim() || !content.trim()} onClick={() => void preview()}><ArrowUp size={18} aria-hidden /></button></IconHint>}
        </div>
        <ComposerResizeHandle inputRef={input} resizeTargetRef={composer} />
      </AttachmentDropZone>
    </div>
  </section>;
}
