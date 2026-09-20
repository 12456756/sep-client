import { ArrowRight, Pencil, Settings2, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { ArrangementDraft, ArrangementDraftDocument } from '../../../shared/types';
import type { SiliconEmployee } from '../../../features/enterprise/types';
import { AutoArrangeAnimation } from './AutoArrangeAnimation';
import { useAutoPlanning } from '../../../features/enterprise/use-auto-planning';
import { GoalComposer } from './GoalComposer';

type Props = {
  employees: SiliconEmployee[];
  workDir: string;
  busy: boolean;
  onChooseFolder: () => Promise<string | null>;
  onOpenSettings: () => void;
  onStart: (draft: ArrangementDraft) => Promise<ArrangementDraft>;
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

export function AutoArrange({ employees, workDir, busy, onChooseFolder, onOpenSettings, onStart }: Props) {
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
          <header className="ent-arr-head">
            <h1>自动编排</h1>
            <p>告诉系统你想完成什么，AI 会自动选择员工并安排工作。</p>
          </header>
        <GoalComposer
          value={goal}
          onChange={setGoal}
          placeholder="描述你想完成的工作，系统会逐步挑选合适的员工并生成编排草稿"
          workDir={workDir}
          onOpenSettings={onOpenSettings}
          onChooseFolder={onChooseFolder}
          submitLabel="开始自动编排"
          submitDisabled={busy || planning || !goal.trim() || !employees.length}
          onSubmit={() => void start(goal, workDir)}
        />
          <p className="ent-arr-note">现在可以派活的同事 {employees.length} 位。编排完成后你可以确认或者重新编排，确认之前不会有人开始干活。</p>
        </section>
      ) : null}
      {error ? <div role="alert" className="workspace-inline-error">{error}</div> : null}
      {draft ? (
        <AutoArrangeAnimation key={draft.id} draft={draft} employees={employees} planning={planning}>
          <footer className="ent-arr-foot">
            <button type="button" className="ent-arr-second" disabled={starting || saving || busy} onClick={() => { setDraft(null); setError(null); }}>重新编排</button>
            <span className="ent-arr-gap" />
            <button type="button" className="ent-arr-ghost" disabled={starting || saving} onClick={onOpenSettings}><Settings2 size={14} aria-hidden />执行设置</button>
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
