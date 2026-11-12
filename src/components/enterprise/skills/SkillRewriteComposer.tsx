import { ArrowUp, Check, ClipboardList, GitCompareArrows, ListChecks, LoaderCircle, MessageSquare, Pencil, RefreshCw, ShieldCheck, Sparkles, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IconHint } from '../IconHint';
import { ModelSelector } from '../ModelSelector';
import { ComposerResizeHandle } from '../ComposerResizeHandle';
import { useModelCatalog } from '../ModelCatalogContext';
import { isSubmitEnter } from '../../../shared/composer-shortcut';
import type { SkillRewriteInput, SkillRewriteResult } from '../../../shared/skill-rewrite';
import { SkillRewriteComparison } from './SkillRewriteComparison';
import type { SkillDraftChange, SkillManualEdit } from '../../../features/enterprise/skill-draft-history';
import { SkillEditRecord } from './SkillEditRecord';

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
  onGeneratingChange(generating: boolean): void;
}

type RoundStatus = 'generating' | 'pending' | 'accepted' | 'ignored' | 'superseded' | 'undone' | 'stale' | 'failed' | 'cancelled';
interface RewriteRound {
  kind: 'rewrite';
  id: string;
  prompt: string;
  source: string;
  revision: number;
  model: string;
  status: RoundStatus;
  result?: SkillRewriteResult;
  error?: string;
}
type AdjustmentRecord = RewriteRound | (SkillManualEdit & { kind: 'manual' });

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
const effectiveStatus = (round: RewriteRound, revision: number): RoundStatus => round.status === 'pending' && round.revision !== revision ? 'stale' : round.status;

export function SkillRewriteComposer({ content, revision, disabled, onRewrite, onCancel, onApply, undoHead, manualEdits, onUndo, onGeneratingChange }: Props): React.JSX.Element {
  const [prompt, setPrompt] = useState('');
  const [rounds, setRounds] = useState<AdjustmentRecord[]>([]);
  const [modelId, setModelId] = useState('');
  const [generating, setGenerating] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const active = useRef<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const catalog = useModelCatalog();
  const models = catalog.models.map(model => model.modelId);
  const selectedModel = models.includes(modelId) ? modelId : models[0] ?? '';
  const latestRound = rounds.at(-1);
  const rewriteNumbers = new Map(rounds.filter(round => round.kind === 'rewrite').map((round, index) => [round.id, index + 1]));

  useEffect(() => {
    setRounds(current => {
      const edits = new Map(manualEdits.map(edit => [edit.id, edit]));
      const known = new Set(current.map(item => item.id));
      return [
        ...current.flatMap<AdjustmentRecord>(item => item.kind === 'rewrite' ? [item] : edits.has(item.id) ? [{ ...edits.get(item.id)!, kind: 'manual' as const }] : []),
        ...manualEdits.filter(edit => !known.has(edit.id)).map(edit => ({ ...edit, kind: 'manual' as const })),
      ];
    });
  }, [manualEdits]);

  useEffect(() => () => {
    const requestId = active.current;
    active.current = null;
    if (requestId) void onCancel(requestId).catch(() => undefined);
    onGeneratingChange(false);
  }, [onCancel, onGeneratingChange]);
  useEffect(() => {
    const panel = history.current;
    const last = panel?.lastElementChild;
    if (panel && last) panel.scrollTop += last.getBoundingClientRect().top - panel.getBoundingClientRect().top;
  }, [latestRound?.id, latestRound?.status]);

  const preview = async (request = prompt, model = selectedModel): Promise<void> => {
    if (disabled || active.current || !model || !request.trim() || !content.trim()) return;
    const round: RewriteRound = { kind: 'rewrite', id: crypto.randomUUID(), prompt: request.trim(), source: content, revision, model, status: 'generating' };
    const previous: SkillRewriteInput['history'] = rounds.flatMap(item => {
      if (item.kind !== 'rewrite') return [];
      const status = effectiveStatus(item, revision);
      return item.result && status !== 'generating' && status !== 'failed' && status !== 'cancelled'
        ? [{ prompt: item.prompt, content: item.result.content, status }] : [];
    }).slice(-3);
    active.current = round.id;
    setGenerating(true); onGeneratingChange(true); setCancelError('');
    setRounds(current => [...current, round]); setPrompt('');
    input.current?.focus();
    try {
      const result = await onRewrite({ requestId: round.id, content, prompt: round.prompt, modelId: model, history: previous });
      if (active.current !== round.id) return;
      if (result.requestId !== round.id) throw new Error('改写结果与本轮请求不匹配，请重试');
      setRounds(current => current.map(item => item.kind !== 'rewrite' ? item : item.id === round.id ? { ...item, result, status: 'pending' }
        : item.status === 'pending' ? { ...item, status: 'superseded' } : item));
    } catch (cause) {
      if (active.current === round.id) setRounds(current => current.map(item => item.kind === 'rewrite' && item.id === round.id
        ? { ...item, status: 'failed', error: cause instanceof Error ? cause.message : '生成失败，请重试' } : item));
    } finally {
      if (active.current === round.id) {
        active.current = null; setGenerating(false); onGeneratingChange(false);
      }
    }
  };
  const cancel = async (): Promise<void> => {
    const requestId = active.current;
    if (!requestId) return;
    try {
      await onCancel(requestId);
      if (active.current !== requestId) return;
      active.current = null; setGenerating(false); onGeneratingChange(false);
      setRounds(current => current.map(item => item.kind === 'rewrite' && item.id === requestId ? { ...item, status: 'cancelled' } : item));
    } catch (cause) {
      setCancelError(cause instanceof Error ? cause.message : '停止失败，请重试');
    }
  };
  const accept = (round: RewriteRound): void => {
    if (disabled || generating || !round.result || effectiveStatus(round, revision) !== 'pending') return;
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
        const status = effectiveStatus(round, revision);
        const canUndo = undoHead?.id === round.id && content === round.result?.content;
        const undoHint = canUndo ? '撤销本轮采纳' : undoHead?.kind === 'manual' ? '请先撤销手动编辑' : '请先撤销后续修改';
        return <article className="skill-chat-round" key={round.id} aria-label={`第 ${number} 轮调整`}>
          <div className="skill-chat-user"><span className="skill-chat-speaker">你</span><p>{round.prompt}</p></div>
          <div className="skill-chat-assistant"><div className="skill-chat-assistant-heading"><Sparkles size={15} aria-hidden /><strong>修改建议</strong><span>{round.model}</span></div>
            {status === 'generating' ? <p className="skill-chat-round-status" role="status"><LoaderCircle size={14} aria-hidden />正在生成修改建议…</p>
              : status === 'failed' ? <div className="skill-chat-round-status"><span className="skill-error" role="alert">{round.error}</span><button className="skill-text-button" type="button" disabled={disabled || generating} onClick={() => void preview(round.prompt, round.model)}><RefreshCw size={13} aria-hidden />重试</button></div>
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
                  : <div className={`skill-chat-round-status is-${status}`} role="status"><span>{statusLabels[status as keyof typeof statusLabels]}</span>{status === 'stale' || status === 'cancelled' ? <button className="skill-text-button" type="button" disabled={disabled || generating} onClick={() => void preview(round.prompt, round.model)}><RefreshCw size={13} aria-hidden />重新生成</button> : null}</div>}
          </div>
        </article>;
      })}
    </div>
    <div className="skill-chat-input-area">
      {catalog.error ? <p className="skill-error" role="alert">{catalog.error}{catalog.retry ? <button className="skill-text-button" type="button" onClick={catalog.retry}>重试</button> : null}</p> : !models.length ? <p className="skill-caption" role="status">暂无可用模型</p> : null}
      {cancelError ? <p className="skill-error" role="alert">{cancelError}</p> : null}
      <div className="skill-rewrite-shortcuts" aria-label="快捷调整要求">{shortcuts.map(item => <button type="button" key={item.label} disabled={disabled} onClick={() => { setPrompt(item.prompt); input.current?.focus(); }}><item.icon size={13} aria-hidden />{item.label}</button>)}</div>
      <div ref={composer} className="skill-rewrite-composer">
        <textarea ref={input} value={prompt} rows={1} maxLength={8_000} aria-label="技能调整要求" placeholder="描述你的调整要求…" disabled={disabled} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (isSubmitEnter(event, event.nativeEvent.isComposing)) { event.preventDefault(); void preview(); } }} />
        <div className="skill-rewrite-tools"><div className="skill-rewrite-model"><ModelSelector models={models} value={selectedModel} title={selectedModel || '模型'} allowEmpty={false} disabled={disabled || generating} onChange={setModelId} /></div>{generating ? <IconHint label="停止生成" side="top"><button type="button" className="skill-rewrite-send" aria-label="停止生成" onClick={() => void cancel()}><Square size={14} aria-hidden /></button></IconHint> : <IconHint label="发送调整要求" side="top"><button type="button" className="skill-rewrite-send" aria-label="发送调整要求" disabled={disabled || !selectedModel || !prompt.trim() || !content.trim()} onClick={() => void preview()}><ArrowUp size={18} aria-hidden /></button></IconHint>}</div>
        <ComposerResizeHandle inputRef={input} resizeTargetRef={composer} />
      </div>
    </div>
  </section>;
}
