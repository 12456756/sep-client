/**
 * 自己编排。左边是工作流程，右边是当前那一步的配置，中间一条极浅的分割线。
 *
 * 刻意**不做**成 n8n / Dify 那种自由连线的画布：员工之间的关系就是先后顺序，
 * 上下拖一拖就能改。要表达的只有「谁先做、谁接着做」，一条竖着的链足够，
 * 多出来的自由度只会让用户面对一张空白画布不知道从哪开始。
 *
 * 顺序调整用 pointer 事件自己实现（HTML5 拖放的拖影和落点在这种卡片列表里对不准），
 * 但键盘一定要能用：把手上按 ↑ ↓ 就是上移下移。
 */

import { ArrowRight, BookmarkPlus, GripVertical, ListPlus, Plus, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useOperationFeedback } from '../../feedback/use-operation-feedback';
import type { SiliconEmployee, WorkDraftStep } from '../../../features/enterprise/types';
import type { RunSettings } from '../../../features/enterprise/run-settings';
import { RunSettingsBar, RunSettingsDirectory } from './RunSettingsDrawer';
import { PromptExamples } from './PromptExamples';
import { createDraftStep, validateGraph } from '../../../features/enterprise/work-graph';
import { EmployeeFace } from '../EmployeeFace';
import { useSpeechInput } from '../../../features/speech/use-speech-input';
import { SpeechInputActions } from '../../speech/SpeechInputActions';
import { AttachmentComposer } from '../attachments/AttachmentComposer';
import { KnowledgeSelector } from '../KnowledgeSelector';
import type { AttachmentImportSession, AttachmentView } from '../../../shared/attachment-contracts';

export interface ManualDraft {
  title: string;
  goal: string;
  steps: WorkDraftStep[];
  confirmedInputs: string[];
  attachmentRefs?: AttachmentView[];
  attachmentSession?: AttachmentImportSession | null;
  mustUseAttachments?: boolean;
}

interface Props {
  employees: SiliconEmployee[];
  busy: boolean;
  /** 从常用工作或企业固定流程带进来的初始内容。 */
  seed: { title?: string; goal?: string; steps: WorkDraftStep[]; confirmedInputs?: string[] } | null;
  onSave: (draft: ManualDraft) => boolean;
  onStart: (draft: ManualDraft) => void;
  settings: RunSettings;
  models: string[];
  onSettingsChange: (patch: Partial<RunSettings>) => void;
  onChooseFolder: (currentPath?: string) => Promise<string | null>;
  attachmentBindingKey?: string;
}

/** 一条链：每一步都依赖上一步。加人、删人、换顺序之后都要重新串一遍。 */
function chain(steps: WorkDraftStep[]): WorkDraftStep[] {
  return steps.map((step, index) => ({ ...step, dependsOn: index ? [steps[index - 1]!.id] : [] }));
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

export function ManualArrange({ employees, busy, seed, onSave, onStart, settings, models, onSettingsChange, onChooseFolder, attachmentBindingKey }: Props) {
  const { capture: captureFeedback } = useOperationFeedback(attachmentBindingKey);
  const [title, setTitle] = useState(seed?.title ?? '');
  const [goal, setGoal] = useState(seed?.goal ?? '');
  const [materials, setMaterials] = useState((seed?.confirmedInputs ?? []).join('\n'));
  const [attachmentRefs, setAttachmentRefs] = useState<AttachmentView[]>([]);
  const [attachmentSession, setAttachmentSession] = useState<AttachmentImportSession | null>(null);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const [mustUseAttachments, setMustUseAttachments] = useState(true);
  const composerId = useRef(`manual-${crypto.randomUUID()}`);
  const [editorVersion, setEditorVersion] = useState(0);
  const editorVersionRef = useRef(0);
  const activeEditor = useRef<{ value: string; update: (value: string) => void } | null>(null);
  const pasteNodeByOperation = useRef(new Map<string, { nodeId: string | null; existingIds: Set<string> }>());
  const activeNodeId = useRef<string | null>(null);
  const knownAttachmentIds = useRef(new Set<string>());
  const [steps, setSteps] = useState<WorkDraftStep[]>(() => chain(seed?.steps.map(step => ({ ...step })) ?? []));
  const [selectedId, setSelectedId] = useState<string | null>(seed?.steps[0]?.id ?? null);
  const attachmentTarget = { kind: 'compose' as const, composerId: composerId.current };
  const onPasteEdit = useCallback(({ operationId, text, selectionStart, selectionEnd, editorVersion: pastedVersion }: { operationId: string; text: string; selectionStart: number; selectionEnd: number; editorVersion: number }) => {
    const editor = activeEditor.current;
    if (!editor || editorVersionRef.current !== pastedVersion) return false;
    pasteNodeByOperation.current.set(operationId, { nodeId: activeNodeId.current, existingIds: new Set(knownAttachmentIds.current) });
    const next = `${editor.value.slice(0, selectionStart)}${text}${editor.value.slice(selectionEnd)}`;
    editor.value = next;
    editor.update(next);
    editorVersionRef.current += 1;
    setEditorVersion(editorVersionRef.current);
    return true;
  }, []);
  const [adding, setAdding] = useState(false);
  const [saved, setSaved] = useState(false);
  const speech = useSpeechInput<HTMLInputElement>({ contextKey: 'manual-goal', value: goal, onChange: value => { setGoal(value); setSaved(false); }, disabled: busy });
  /** 正在拖的那一张：从第几个开始、跟着指针走了多远、一格多高、是否已经松手在归位。 */
  const [drag, setDrag] = useState<{ id: string; from: number; dy: number; rowH: number; settling: boolean } | null>(null);
  const list = useRef<HTMLUListElement>(null);

  const selected = steps.find(step => step.id === selectedId) ?? null;
  const problem = validateGraph(steps);
  const fallbackTitle = goal.trim().slice(0, 24) || '未命名工作';
  const confirmedInputs = materials.split('\n').map(line => line.trim()).filter(Boolean);
  const draft = (): ManualDraft => ({
    title: title.trim() || fallbackTitle,
    goal: goal.trim() || title.trim() || fallbackTitle,
    steps,
    confirmedInputs,
    attachmentRefs,
    attachmentSession,
    mustUseAttachments,
  });

  const replace = (next: WorkDraftStep[]) => { setSteps(chain(next)); setSaved(false); };

  const add = (employeeId: string) => {
    const step = createDraftStep(employeeId);
    replace([...steps, step]);
    setSelectedId(step.id);
    setAdding(false);
  };

  const patch = (id: string, change: Partial<WorkDraftStep>) => {
    setSteps(current => current.map(step => (step.id === id ? { ...step, ...change } : step)));
    setSaved(false);
  };

  const updateFocusedEditor = (value: string, update: (value: string) => void) => {
    activeEditor.current = { value, update };
  };

  const updateEditorValue = (value: string, update: (value: string) => void) => {
    activeEditor.current = { value, update };
    editorVersionRef.current += 1;
    setEditorVersion(editorVersionRef.current);
  };

  const handleAttachmentsChange = (items: AttachmentView[]) => {
    knownAttachmentIds.current = new Set(items.map(item => item.attachmentId));
    setAttachmentRefs(items);
  };

  const handlePasteStarted = (operationId: string) => {
    if (!pasteNodeByOperation.current.has(operationId)) pasteNodeByOperation.current.set(operationId, { nodeId: activeNodeId.current, existingIds: new Set(knownAttachmentIds.current) });
  };

  const bindNewAttachments = (nodeId: string | null, items: AttachmentView[]) => {
    if (!nodeId) return;
    if (!items.length) return;
    setSteps(previous => previous.map(step => {
      if (step.id !== nodeId) return step;
      const refs = [...(step.inputRefs ?? [])];
      for (const item of items) {
        if (refs.some(ref => ref.kind === 'attachment' && ref.attachment.attachmentId === item.attachmentId)) continue;
        refs.push({ kind: 'attachment', attachment: { attachmentId: item.attachmentId, sha256: item.sha256 }, required: true, purpose: 'reference' });
      }
      return { ...step, inputRefs: refs };
    }));
  };

  const handlePasteImported = (operationId: string, items: AttachmentView[]) => {
    const operation = pasteNodeByOperation.current.get(operationId);
    pasteNodeByOperation.current.delete(operationId);
    if (!operation) return;
    bindNewAttachments(operation.nodeId, items.filter(item => !operation.existingIds.has(item.attachmentId)));
  };

  const remove = (id: string) => {
    replace(steps.filter(step => step.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const reorder = (from: number, to: number) => {
    if (to < 0 || to >= steps.length) return;
    replace(move(steps, from, to));
  };

  /** 一格有多高：量前两张卡的间距，量不到（只有一张）就用卡高 + 连线的标称值。 */
  const rowHeight = (): number => {
    const items = list.current?.querySelectorAll<HTMLElement>('.ent-mn-item');
    if (items && items.length > 1) return items[1]!.offsetTop - items[0]!.offsetTop;
    return 132;
  };

  const startDrag = (event: React.PointerEvent, id: string, from: number) => {
    event.preventDefault();
    // 起点和格高在这一次拖动里是常量，闭包捕获比放 ref 稳 —— 松手时 ref 已经被清掉了。
    const startY = event.clientY;
    const rowH = rowHeight();
    const total = steps.length;
    setDrag({ id, from, dy: 0, rowH, settling: false });

    const slotOf = (clientY: number) => {
      const shift = Math.round((clientY - startY) / rowH);
      return Math.max(0, Math.min(total - 1, from + shift));
    };

    const onMove = (moved: PointerEvent) => {
      setDrag({ id, from, dy: moved.clientY - startY, rowH, settling: false });
    };
    const onUp = (up: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const to = slotOf(up.clientY);
      // 先滑到目标格，再真的换顺序 —— 直接换会瞬移，看不出吸附。
      setDrag({ id, from, dy: (to - from) * rowH, rowH, settling: true });
      window.setTimeout(() => { reorder(from, to); setDrag(null); }, 220);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /** 拖动中其他卡片让位：夹在起点和落点之间的整体上移或下移一格。 */
  const shiftOf = (index: number): number => {
    if (!drag) return 0;
    const to = Math.max(0, Math.min(steps.length - 1, drag.from + Math.round(drag.dy / drag.rowH)));
    if (index === drag.from) return 0;
    if (to > drag.from && index > drag.from && index <= to) return -drag.rowH;
    if (to < drag.from && index < drag.from && index >= to) return drag.rowH;
    return 0;
  };

  return (
    <section className="ent-arr-manual">

      <div className="ent-mn">
        <div className="ent-mn-flow">
          {steps.length ? (
            <ul className={`ent-mn-list${drag ? ' busy' : ''}`} ref={list}>
              {steps.map((step, index) => {
                const employee = employees.find(item => item.id === step.employeeId);
                const isDragged = drag?.id === step.id;
                const offset = isDragged ? drag!.dy : shiftOf(index);
                return (
                  <li
                    key={step.id}
                    className={`ent-mn-item${isDragged ? ' dragging' : ''}${drag && !isDragged ? ' faded' : ''}`}
                    style={{
                      transform: offset ? `translateY(${offset}px)` : undefined,
                      transition: drag && (!isDragged || drag.settling) ? 'transform 220ms cubic-bezier(.22,1,.36,1)' : undefined,
                    }}
                  >
                    <button
                      type="button"
                      className={`ent-mn-node${selectedId === step.id ? ' on' : ''}`}
                      onClick={() => setSelectedId(step.id)}
                      aria-pressed={selectedId === step.id}
                    >
                      <span className="ent-mn-no" aria-hidden>{String(index + 1).padStart(2, '0')}</span>
                      <EmployeeFace employee={employee} name="还没有指定员工" size="md" round />
                      <span className="ent-mn-id">
                        <strong>{employee?.name ?? '还没有指定员工'}</strong>
                        <small>{employee?.roleName ?? '点这里选一位同事'}</small>
                        <em className={step.title.trim() ? undefined : 'blank'}>
                          {step.title.trim() || '还没有写这一步做什么'}
                        </em>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ent-mn-grip"
                      onPointerDown={event => startDrag(event, step.id, index)}
                      onKeyDown={event => {
                        if (event.key === 'ArrowUp') { event.preventDefault(); reorder(index, index - 1); }
                        if (event.key === 'ArrowDown') { event.preventDefault(); reorder(index, index + 1); }
                      }}
                      aria-label={`调整第 ${index + 1} 步的顺序，上下方向键可以移动`}
                    >
                      <GripVertical size={14} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="ent-mn-del"
                      onClick={() => remove(step.id)}
                      aria-label={`删除第 ${index + 1} 步`}
                    >
                      <X size={12} aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="ent-mn-empty-state">
              <span className="ent-mn-empty-icon" aria-hidden="true"><ListPlus size={22} strokeWidth={1.8} /></span>
              <span>添加员工，开始编排</span>
              {!goal && !busy ? <PromptExamples mode="arrangement" disabled={speech.busy} inputRef={speech.inputProps.ref} onSelect={prompt => {
                setGoal(prompt);
                setSaved(false);
                activeNodeId.current = null;
                updateEditorValue(prompt, value => { setGoal(value); setSaved(false); });
              }} /> : null}
            </div>
          )}

          <div className="ent-mn-add">
            <button type="button" className="ent-mn-addbtn" onClick={() => setAdding(open => !open)} aria-expanded={adding}>
              <Plus size={14} aria-hidden />
              添加员工
            </button>
            {adding ? (
              <ul className="ent-mn-pick">
                {employees.map(employee => (
                  <li key={employee.id}>
                    <button type="button" onClick={() => add(employee.id)}>
                      <EmployeeFace employee={employee} size="sm" round />
                      <span>
                        <strong>{employee.name}</strong>
                        <small>{employee.roleName}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        <aside className="ent-mn-side" aria-label={selected ? '当前步骤的配置' : '这项工作'}>
          {selected ? (
            <StepForm
              step={selected}
              globalKnowledge={settings.knowledge}
              scopeKey={attachmentBindingKey}
              employees={employees}
              order={steps.findIndex(item => item.id === selected.id) + 1}
              onPatch={change => patch(selected.id, change)}
              attachments={attachmentRefs}
              composerId={composerId.current}
              editorVersion={editorVersion}
              updateFocusedEditor={updateFocusedEditor}
              updateEditorValue={updateEditorValue}
              onFocusNode={nodeId => { activeNodeId.current = nodeId; }}
            />
          ) : (
            <>
              <h2>工作设置</h2>
              <label className="ent-mn-field">
                <span>工作名称</span>
                <input
                  className="ent-mn-input"
                  value={title}
                  placeholder={fallbackTitle}
                  onChange={event => { setTitle(event.target.value); setSaved(false); }}
                />
              </label>
              <label className="ent-mn-field">
                <span>你已经准备好的资料</span>
                <textarea
                  className="ent-mn-input tall"
                  value={materials}
                  data-composer-id={composerId.current}
                  data-editor-version={editorVersion}
                  placeholder={'一行写一项，例如：\n客户资料在「客户/2026」文件夹\n上季度周报可以作为格式参考'}
                  onFocus={() => { activeNodeId.current = null; updateFocusedEditor(materials, value => { setMaterials(value); setSaved(false); }); }}
                  onChange={event => { setMaterials(event.target.value); updateEditorValue(event.target.value, value => { setMaterials(value); setSaved(false); }); setSaved(false); }}
                />
              </label>
            </>
          )}
          <AttachmentComposer target={attachmentTarget} bindingKey={attachmentBindingKey} disabled={busy} onBusyChange={setAttachmentsBusy} onPasteStarted={handlePasteStarted} onPasteImported={handlePasteImported} onSelectStarted={() => { pasteNodeByOperation.current.set('__picker__', { nodeId: null, existingIds: new Set(knownAttachmentIds.current) }); }} onSelectFinished={items => {
            const picker = pasteNodeByOperation.current.get('__picker__');
            pasteNodeByOperation.current.delete('__picker__');
            if (picker && items) bindNewAttachments(picker.nodeId, items.filter(item => !picker.existingIds.has(item.attachmentId)));
          }} onChange={items => {
            handleAttachmentsChange(items);
            const retained = new Set(items.map(item => item.attachmentId));
            setSteps(current => current.map(step => ({ ...step, inputRefs: step.inputRefs?.filter(ref => ref.kind !== 'attachment' || retained.has(ref.attachment.attachmentId)) })));
          }} onSessionChange={setAttachmentSession} onPasteEdit={onPasteEdit} />
          {attachmentRefs.length ? <label className="ent-attachment-usage"><input type="checkbox" checked={mustUseAttachments} onChange={event => { setMustUseAttachments(event.target.checked); setSaved(false); }} />必须安排到至少一个步骤</label> : null}
        </aside>
      </div>

      <footer className="ent-mn-composer">
        <input
          {...speech.inputProps}
          className="ent-mn-goal"
          data-composer-id={composerId.current}
          data-editor-version={editorVersion}
          value={goal}
          placeholder="描述这项工作"
          aria-label="工作目标"
          onFocus={() => { activeNodeId.current = null; updateFocusedEditor(goal, value => { setGoal(value); setSaved(false); }); }}
          onChange={event => { setGoal(event.target.value); updateEditorValue(event.target.value, value => { setGoal(value); setSaved(false); }); setSaved(false); }}
        />
        <div className="ent-mn-composer-bar">
          <div className="ent-mn-inline-settings">
            <RunSettingsDirectory settings={settings} onChange={onSettingsChange} onChooseFolder={onChooseFolder} />
            <RunSettingsBar
              settings={settings}
              models={models}
              onChange={onSettingsChange}
            />
            <KnowledgeSelector value={settings.knowledge} onChange={knowledge => onSettingsChange({ knowledge })} disabled={busy} scopeKey={attachmentBindingKey} />
          </div>
          <button
            type="button"
            className="ent-arr-second"
            disabled={!steps.length || saved || speech.busy}
            onClick={() => { setSaved(onSave(draft())); }}
          >
            <BookmarkPlus size={14} aria-hidden />
            {saved ? '已保存' : '保存'}
          </button>
          <span className="ent-arr-gap" />
          <SpeechInputActions speech={speech} disabled={busy} />
          <button
            type="button"
            className="ent-arr-primary"
            disabled={busy || speech.busy || attachmentsBusy || !steps.length}
            onClick={() => {
              if (speech.busy) return;
              if (problem) { captureFeedback().show(problem, 'warning'); return; }
              onStart(draft());
            }}
          >
            {busy ? '安排中…' : '开始'}
            <ArrowRight size={15} aria-hidden />
          </button>
        </div>
      </footer>
    </section>
  );
}

/** 右栏：当前这一步做什么。字段顺序按用户的思考顺序排，不按数据结构排。 */
function StepForm({ step, globalKnowledge, scopeKey, employees, order, onPatch, attachments, composerId, editorVersion, updateFocusedEditor, updateEditorValue, onFocusNode }: {
  step: WorkDraftStep;
  globalKnowledge: RunSettings['knowledge'];
  scopeKey?: string;
  employees: SiliconEmployee[];
  order: number;
  onPatch: (change: Partial<WorkDraftStep>) => void;
  attachments: AttachmentView[];
  composerId: string;
  editorVersion: number;
  updateFocusedEditor: (value: string, update: (value: string) => void) => void;
  updateEditorValue: (value: string, update: (value: string) => void) => void;
  onFocusNode: (nodeId: string) => void;
}) {
  const employee = employees.find(item => item.id === step.employeeId);
  return (
    <>
      <header className="ent-mn-side-head">
        <EmployeeFace employee={employee} name="还没有指定员工" size="md" round />
        <span>
          <strong>{employee?.name ?? '还没有指定员工'}</strong>
          <small>{employee?.roleName ?? '未指定'}</small>
        </span>
        <em>第 {order} 步</em>
      </header>
      <div className="ent-mn-field">
        <span>本步骤知识库 · {step.knowledge ? '单独设置' : '继承全局'}</span>
        <KnowledgeSelector key={step.id} value={step.knowledge ?? globalKnowledge} onChange={knowledge => onPatch({ knowledge })} scopeKey={scopeKey} />
        {step.knowledge ? <button type="button" className="ent-arr-second" onClick={() => onPatch({ knowledge: undefined })}>继承全局</button> : null}
      </div>
      {(step.knowledge ?? globalKnowledge).mode === 'auto' ? <label className="ent-mn-field"><span>自动检索问题（可选）</span><input className="ent-mn-input" maxLength={1000} value={step.knowledgeQuery ?? ''} onChange={event => onPatch({ knowledgeQuery: event.target.value.trim() ? event.target.value : undefined })} placeholder="留空时本步骤不检索" /></label> : null}

      <label className="ent-mn-field">
        <span>工作</span>
        <textarea
          className="ent-mn-input tall"
          value={step.title}
            data-composer-id={composerId}
            data-editor-version={editorVersion}
          placeholder="例如：整理 618 活动的销售数据"
          onFocus={() => { updateFocusedEditor(step.title, value => { onPatch({ title: value }); }); onFocusNode(step.id); }}
          onChange={event => { const value = event.target.value; updateEditorValue(value, next => onPatch({ title: next })); onPatch({ title: value }); }}
        />
      </label>

      {attachments.length ? <fieldset className="ent-mn-field ent-mn-attachment-bind">
        <legend>本步骤使用的附件</legend>
        {attachments.map(item => {
          const existing = step.inputRefs?.find(ref => ref.kind === 'attachment' && ref.attachment.attachmentId === item.attachmentId);
          const checked = Boolean(existing);
          return <label key={item.attachmentId}><input type="checkbox" checked={checked} onChange={event => {
            const refs = (step.inputRefs ?? []).filter(ref => ref.kind !== 'attachment' || ref.attachment.attachmentId !== item.attachmentId);
            if (event.target.checked) refs.push({ kind: 'attachment', attachment: { attachmentId: item.attachmentId, sha256: item.sha256 }, required: existing?.kind === 'attachment' ? existing.required : true, purpose: existing?.kind === 'attachment' ? existing.purpose : 'reference' });
            onPatch({ inputRefs: refs });
          }} /><span>{item.displayName}</span>{checked ? <select value={existing?.kind === 'attachment' ? existing.purpose : 'reference'} onChange={event => { const refs = (step.inputRefs ?? []).map(ref => ref.kind === 'attachment' && ref.attachment.attachmentId === item.attachmentId ? { ...ref, purpose: event.target.value as 'reference' | 'analysis' | 'vision' | 'media-source' } : ref); onPatch({ inputRefs: refs }); }}><option value="reference">参考</option><option value="analysis">分析</option><option value="vision">视觉</option><option value="media-source">媒体源</option></select> : null}{checked ? <label><input type="checkbox" checked={existing?.kind === 'attachment' ? existing.required : true} onChange={event => onPatch({ inputRefs: (step.inputRefs ?? []).map(ref => ref.kind === 'attachment' && ref.attachment.attachmentId === item.attachmentId ? { ...ref, required: event.target.checked } : ref) })} />必需</label> : null}</label>;
        })}
      </fieldset> : null}

      <div className="ent-mn-pair">
        <label className="ent-mn-field">
          <span>输入</span>
          <input
            className="ent-mn-input"
            value={step.input}
            data-composer-id={composerId}
            data-editor-version={editorVersion}
            placeholder="留空表示用上一步的结果"
            onFocus={() => { updateFocusedEditor(step.input, value => { onPatch({ input: value }); }); onFocusNode(step.id); }}
            onChange={event => { const value = event.target.value; updateEditorValue(value, next => { onPatch({ input: next }); }); onPatch({ input: value }); }}
          />
        </label>
        <label className="ent-mn-field">
          <span>输出</span>
          <input
            className="ent-mn-input"
            value={step.output}
            data-composer-id={composerId}
            data-editor-version={editorVersion}
            placeholder="例如：一份销售数据汇总表"
            onFocus={() => { updateFocusedEditor(step.output, value => { onPatch({ output: value }); }); onFocusNode(step.id); }}
            onChange={event => { const value = event.target.value; updateEditorValue(value, next => { onPatch({ output: next }); }); onPatch({ output: value }); }}
          />
        </label>
      </div>

      <label className="ent-mn-field">
        <span>负责人</span>
        <select className="ent-mn-input" value={step.employeeId} onChange={event => onPatch({ employeeId: event.target.value })}>
          <option value="">还没有指定</option>
          {employees.map(item => <option key={item.id} value={item.id}>{item.name}（{item.roleName}）</option>)}
        </select>
      </label>

      <label className="ent-mn-check">
        <input type="checkbox" checked={step.needsConfirm} onChange={event => onPatch({ needsConfirm: event.target.checked })} />
        <span>这一步完成后先等我确认，再往下走</span>
      </label>
    </>
  );
}
