import { ArrowRight, Pencil, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { ArrangementDraft, ArrangementDraftDocument } from '../../../shared/types';
import type { SiliconEmployee } from '../../../features/enterprise/types';
import type { RunSettings } from '../../../features/enterprise/run-settings';
import { AutoArrangeAnimation } from './AutoArrangeAnimation';
import { useAutoPlanning } from '../../../features/enterprise/use-auto-planning';
import { GoalComposer } from './GoalComposer';

type Props = {
  employees: SiliconEmployee[];
  busy: boolean;
  onStart: (draft: ArrangementDraft) => Promise<ArrangementDraft>;
  settings: RunSettings;
  models: string[];
  onSettingsChange: (patch: Partial<RunSettings>) => void;
  onChooseFolder: () => Promise<string | null>;
};

function toDocument(draft: ArrangementDraft): ArrangementDraftDocument {
  return {
    schemaVersion: 1,
    mode: draft.mode,
    title: draft.title,
    goal: draft.goal,
    confirmedInputs: [...draft.confirmedInputs],
    sharedSkillIds: [...draft.sharedSkillIds],
    conversation: draft.conversation ? structuredClone(draft.conversation) : null,
    nodes: draft.nodes.map(node => ({ ...node, dependsOn: [...node.dependsOn], skillIds: [...node.skillIds] })),
    workspace: { ...draft.workspace },
    permissions: { ...draft.permissions },
    lastPlanning: draft.lastPlanning ? { ...draft.lastPlanning } : null,
  };
}

export function AutoArrange({ employees, busy, onStart, settings, models, onSettingsChange, onChooseFolder }: Props) {
  const [starting, setStarting] = useState(false);
  const [goal, setGoal] = useState('');
  const { draft, setDraft, planning, cancellable, error, setError, start, cancel } = useAutoPlanning();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const updateDraft = async (patch: Partial<Pick<ArrangementDraft, 'title' | 'goal' | 'nodes' | 'sharedSkillIds'>>): Promise<void> => {
    if (!draft || planning || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await window.electronAPI.updateArrangementDraft({ draftId: draft.id, expectedRevision: draft.revision, document: toDocument({ ...draft, ...patch }) });
      if (!result.success || !result.draft) throw new Error(result.error?.message || '保存编排草稿失败');
      setDraft(result.draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存编排草稿失败');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const confirmAndStart = async (): Promise<void> => {
    if (!draft || starting || busy || planning || savingRef.current) return;
    setStarting(true);
    try {
      // Saving execution settings increments the revision, including when preflight fails.
      setDraft(await onStart(draft));
    } catch {
      setError('启动工作失败，请重试');
    } finally {
      setStarting(false);
    }
  };

  const employeeById = useMemo(() => new Map(employees.map(employee => [employee.id, employee])), [employees]);

  return (
    <div className="ent-auto-arrange">
      {!draft ? (
        <section className="ent-arr-auto">
        <GoalComposer
          value={goal}
          onChange={setGoal}
          placeholder="随心输入"
          submitLabel="开始自动编排"
          settings={settings}
          models={models}
          onSettingsChange={onSettingsChange}
          onChooseFolder={onChooseFolder}
          submitDisabled={busy || planning || !goal.trim() || !employees.length}
          conversation={false}
          onSubmit={() => void start(goal, settings.workDir)}
        />
        </section>
      ) : null}
      {error ? <div role="alert" className="workspace-inline-error">{error}</div> : null}
      {draft ? (
        <AutoArrangeAnimation key={draft.id} draft={draft} employees={employees} planning={planning}>
          <footer className="ent-arr-foot">
            <button type="button" className="ent-arr-second" disabled={starting || saving || busy} onClick={() => { setDraft(null); setError(null); }}>重新编排</button>
            <span className="ent-arr-gap" />
            {draft.nodes.length > 0 && draft.status !== 'confirmed' ? <button type="button" className="ent-arr-primary" disabled={starting || busy || saving} onClick={() => void confirmAndStart()}>{starting ? '正在启动…' : '确认并开始工作'}<ArrowRight size={15} aria-hidden /></button> : null}
          </footer>
          <details className="ent-auto-plan">
            <summary>编辑编排草稿</summary>
            <label className="ent-auto-field">标题<input value={draft.title} disabled={planning || starting || saving} onChange={event => setDraft(current => current ? { ...current, title: event.target.value } : current)} onBlur={() => void updateDraft({ title: draft.title })} /></label>
            <label className="ent-auto-field">工作目标<textarea value={draft.goal} disabled={planning || starting || saving} onChange={event => setDraft(current => current ? { ...current, goal: event.target.value } : current)} onBlur={() => void updateDraft({ goal: draft.goal })} /></label>
            {draft.nodes.map((node, index) => {
              const employee = employeeById.get(node.subscriptionId);
              return (
                <article key={node.id} className="ent-panel ent-auto-node">
                  <div className="flex items-center gap-2"><Pencil size={14} /><strong>步骤 {index + 1}</strong><span>{employee?.name ?? node.subscriptionId}</span></div>
                  <label className="ent-auto-field">步骤名称<input disabled={planning || starting || saving} value={node.title} onChange={event => setDraft(current => current ? { ...current, nodes: current.nodes.map(item => item.id === node.id ? { ...item, title: event.target.value } : item) } : current)} /></label>
                  <label className="ent-auto-field">执行说明<textarea disabled={planning || starting || saving} value={node.instruction} onChange={event => setDraft(current => current ? { ...current, nodes: current.nodes.map(item => item.id === node.id ? { ...item, instruction: event.target.value } : item) } : current)} /></label>
                  <label className="ent-auto-field">预期输出<textarea disabled={planning || starting || saving} value={node.expectedOutput} onChange={event => setDraft(current => current ? { ...current, nodes: current.nodes.map(item => item.id === node.id ? { ...item, expectedOutput: event.target.value } : item) } : current)} /></label>
                </article>
              );
            })}
            {!planning && draft.nodes.length ? <button type="button" className="ent-btn" disabled={starting || saving} onClick={() => void updateDraft({ nodes: draft.nodes })}>保存步骤修改</button> : null}
          </details>
        </AutoArrangeAnimation>
      ) : null}
      {planning && draft ? <button type="button" className="ent-arr-second" disabled={!cancellable} onClick={() => void cancel()}><X size={14} aria-hidden />取消编排</button> : null}
    </div>
  );
}
