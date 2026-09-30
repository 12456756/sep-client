import { ArrowRight, Pencil, RefreshCw, Settings2, Workflow, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { ArrangementDraft, ArrangementDraftDocument } from '../../../shared/types';
import type { SiliconEmployee } from '../../../features/enterprise/types';
import type { RunSettings } from '../../../features/enterprise/run-settings';
import { AutoArrangeAnimation } from './AutoArrangeAnimation';
import { useAutoPlanning } from '../../../features/enterprise/use-auto-planning';
import { GoalComposer } from './GoalComposer';
import { RunSettingsBar, RunSettingsDirectory } from './RunSettingsDrawer';

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
    intentAnalysis: draft.intentAnalysis ? structuredClone(draft.intentAnalysis) : null,
    unresolvedSteps: draft.unresolvedSteps ? structuredClone(draft.unresolvedSteps) : [],
    candidateMatches: draft.candidateMatches ? structuredClone(draft.candidateMatches) : [],
    employeeAccessRequests: draft.employeeAccessRequests ? structuredClone(draft.employeeAccessRequests) : [],
    lastPlanning: draft.lastPlanning ? { ...draft.lastPlanning } : null,
  };
}

export function AutoArrange({ employees, busy, onStart, settings, models, onSettingsChange, onChooseFolder }: Props) {
  const [starting, setStarting] = useState(false);
  const [goal, setGoal] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const {
    draft,
    setDraft,
    events,
    planning,
    cancellable,
    error,
    setError,
    start,
    cancel,
    requestEmployeeAccess,
    refreshEmployeeAccess,
    recheck,
  } = useAutoPlanning();
  const [saving, setSaving] = useState(false);
  const [requestingKey, setRequestingKey] = useState<string | null>(null);
  const [refreshingRequestId, setRefreshingRequestId] = useState<string | null>(null);
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

  const submitGoal = () => {
    setSubmitted(true);
    void start(goal, settings.workDir, settings.modelId || undefined);
  };

  const requestAccess = async (stepId: string, employeeId: string): Promise<void> => {
    const key = `${stepId}:${employeeId}`;
    setRequestingKey(key);
    setError(null);
    try {
      await requestEmployeeAccess(stepId, employeeId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '申请员工失败，请稍后重试');
    } finally {
      setRequestingKey(current => current === key ? null : current);
    }
  };

  const refreshRequest = async (requestId: string): Promise<void> => {
    setRefreshingRequestId(requestId);
    setError(null);
    try {
      await refreshEmployeeAccess(requestId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '查询申请状态失败，请稍后重试');
    } finally {
      setRefreshingRequestId(current => current === requestId ? null : current);
    }
  };

  const employeeById = useMemo(() => new Map(employees.map(employee => [employee.id, employee])), [employees]);
  const intentStepById = useMemo(() => new Map((draft?.intentAnalysis?.steps ?? []).map(step => [step.id, step])), [draft?.intentAnalysis]);

  return (
    <div className="ent-auto-arrange">
      {!draft ? (
        <section className="ent-arr-auto">
        {!submitted && !planning ? (
          <div className="ent-arr-empty-state" aria-hidden="true">
            <span className="ent-arr-empty-icon"><Workflow size={24} strokeWidth={1.8} /></span>
            <p>描述一个目标，开始编排</p>
          </div>
        ) : null}
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
          onSubmit={submitGoal}
        />
        </section>
      ) : null}
      {error ? <div role="alert" className="workspace-inline-error">{error}</div> : null}
      {draft ? (
        <AutoArrangeAnimation key={draft.id} draft={draft} employees={employees} planning={planning} planningEvents={events}>
          {draft.status === 'awaiting-employee' ? (
            <section className="ent-aa-waiting">
              <div className="ent-aa-waiting-head">
                <div>
                  <h2>还缺少员工，当前编排已暂停</h2>
                  <p>申请员工不会阻塞客户端。申请通过后点击“重新检查”，系统会复用当前草稿继续匹配。</p>
                </div>
                <button type="button" className="ent-arr-primary" disabled={planning || requestingKey !== null || refreshingRequestId !== null} onClick={() => void recheck(settings.modelId || undefined)}>
                  <RefreshCw size={14} aria-hidden />重新检查
                </button>
              </div>
              <div className="ent-aa-missing-list">
                {(draft.unresolvedSteps ?? []).map(step => {
                  const candidates = (draft.candidateMatches ?? []).filter(candidate => candidate.stepId === step.stepId);
                  return (
                    <article className="ent-aa-missing" key={step.stepId}>
                      <div className="ent-aa-missing-title"><strong>{intentStepById.get(step.stepId)?.title ?? step.stepId}</strong><span>{step.reason}</span></div>
                      <p>需要能力：{step.requiredCapabilities.join('、') || '未指定'}</p>
                      {candidates.length ? candidates.map(candidate => {
                        const request = (draft.employeeAccessRequests ?? []).find(item => item.stepId === step.stepId && item.employeeId === candidate.employeeId);
                        const key = `${step.stepId}:${candidate.employeeId}`;
                        const statusText = request?.status === 'PENDING' ? '申请中' : request?.status === 'APPROVED' ? '已通过' : request?.status === 'REJECTED' ? '已拒绝' : request?.status === 'CANCELLED' ? '已取消' : null;
                        return (
                          <div className="ent-aa-candidate" key={key}>
                            <span className="ent-aa-candidate-mark">{candidate.name.slice(0, 1) || '?'}</span>
                            <span className="ent-aa-candidate-info"><strong>{candidate.name}</strong><small>{candidate.source === 'enterprise' ? '企业员工' : '平台员工'} · {candidate.rationale}</small></span>
                            {statusText ? <span className={`ent-aa-request-status ${request?.status?.toLowerCase() ?? ''}`}>{statusText}</span> : null}
                            {!request || request.status === 'REJECTED' || request.status === 'CANCELLED' ? (
                              <button type="button" className="ent-btn" disabled={requestingKey !== null || refreshingRequestId !== null} onClick={() => void requestAccess(step.stepId, candidate.employeeId)}>{requestingKey === key ? '提交中…' : '申请员工'}</button>
                            ) : request.status === 'PENDING' ? (
                              <button type="button" className="ent-btn" disabled={requestingKey !== null || refreshingRequestId !== null} onClick={() => void refreshRequest(request.requestId)}>{refreshingRequestId === request.requestId ? '查询中…' : '查询状态'}</button>
                            ) : null}
                          </div>
                        );
                      }) : <p className="ent-aa-empty">暂未找到可申请的员工，请调整目标后重新编排。</p>}
                    </article>
                  );
                })}
              </div>
            </section>
          ) : null}
          <footer className="ent-arr-foot">
            <button type="button" className="ent-arr-second" disabled={starting || saving || planning} onClick={() => { setDraft(null); setError(null); }}>重新编排</button>
            <span className="ent-arr-gap" />
            <button type="button" className="ent-arr-ghost" disabled={starting || saving} aria-expanded={settingsOpen} onClick={() => setSettingsOpen(open => !open)}><Settings2 size={14} aria-hidden />执行设置</button>
            {draft.nodes.length > 0 && draft.status !== 'confirmed' && draft.status !== 'awaiting-employee' ? <button type="button" className="ent-arr-primary" disabled={starting || busy || saving} onClick={() => void confirmAndStart()}>{starting ? '正在启动…' : '确认并开始工作'}<ArrowRight size={15} aria-hidden /></button> : null}
          </footer>
          {settingsOpen ? (
            <div className="ent-auto-plan">
              <RunSettingsDirectory settings={settings} onChange={onSettingsChange} onChooseFolder={onChooseFolder} />
              <RunSettingsBar settings={settings} models={models} conversation={false} onChange={onSettingsChange} />
            </div>
          ) : null}
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
