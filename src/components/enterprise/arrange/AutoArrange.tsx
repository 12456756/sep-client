import { ArrowRight, RefreshCw, Settings2, Workflow, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useOperationFeedback } from '../../feedback/use-operation-feedback';
import { responseError } from '../../../shared/arrangement-feedback';
import type { ArrangementDraft } from '../../../shared/types';
import type { SiliconEmployee } from '../../../features/enterprise/types';
import type { RunSettings } from '../../../features/enterprise/run-settings';
import { AutoArrangeAnimation } from './AutoArrangeAnimation';
import { useAutoPlanning } from '../../../features/enterprise/use-auto-planning';
import { GoalComposer } from './GoalComposer';
import { RunSettingsBar, RunSettingsDirectory } from './RunSettingsDrawer';
import type { AttachmentImportSession, AttachmentView, NodeInputRef } from '../../../shared/attachment-contracts';

type Props = {
  employees: SiliconEmployee[];
  busy: boolean;
  onStart: (draft: ArrangementDraft) => Promise<ArrangementDraft>;
  settings: RunSettings;
  models: string[];
  onSettingsChange: (patch: Partial<RunSettings>) => void;
  onChooseFolder: (currentPath?: string) => Promise<string | null>;
  attachmentRefs?: AttachmentView[];
  attachmentSession?: AttachmentImportSession | null;
  attachmentBindingKey?: string;
};

export function AutoArrange({ employees, busy, onStart, settings, models, onSettingsChange, onChooseFolder, attachmentBindingKey }: Props) {
  const [starting, setStarting] = useState(false);
  const [goal, setGoal] = useState('');
  const [attachmentRefs, setAttachmentRefs] = useState<AttachmentView[]>([]);
  const [attachmentSession, setAttachmentSession] = useState<AttachmentImportSession | null>(null);
  const [mustUseAttachments, setMustUseAttachments] = useState(true);
  const [attachmentSaveBusy, setAttachmentSaveBusy] = useState(false);
  const [attachmentDirty, setAttachmentDirty] = useState(false);
  const { capture: captureFeedback } = useOperationFeedback(attachmentBindingKey);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const {
    draft,
    setDraft,
    events,
    planning,
    cancellable,
    start,
    cancel,
    requestEmployeeAccess,
    refreshEmployeeAccess,
    recheck,
    recheckDraft,
  } = useAutoPlanning(attachmentBindingKey);
  const [requestingKey, setRequestingKey] = useState<string | null>(null);
  const [refreshingRequestId, setRefreshingRequestId] = useState<string | null>(null);

  const confirmAndStart = async (): Promise<void> => {
    if (!draft || starting || busy || planning || attachmentDirty || attachmentsBusy) return;
    setStarting(true);
    const notice = captureFeedback();
    try {
      // Saving execution settings increments the revision, including when preflight fails.
      const updated = await onStart(draft);
      if (notice.isCurrent()) setDraft(updated);
    } catch {
      notice.fail(undefined, 'start');
    } finally {
      if (notice.isCurrent()) setStarting(false);
    }
  };

  const saveAttachmentAssignments = async (): Promise<void> => {
    if (!draft || attachmentSaveBusy || planning) return;
    setAttachmentSaveBusy(true);
    const notice = captureFeedback();
    try {
      const result = await window.electronAPI.updateArrangementInputs({
        draftId: draft.id,
        expectedRevision: draft.revision,
        inputs: {
          attachmentSessionId: attachmentSession?.sessionId,
          attachmentCandidates: draft.attachmentCandidates ?? [],
          nodes: draft.nodes.map(node => ({ nodeId: node.id, inputRefs: node.inputRefs ?? [] })),
        },
      });
      if (!notice.isCurrent()) return;
      if (!result.success || !result.draft) throw responseError(result, 'attachments');
      setDraft(result.draft);
      setAttachmentDirty(false);
      if (result.draft.mode === 'auto') {
        setAttachmentSaveBusy(false);
        await recheckDraft(result.draft, settings.modelId, true);
        return;
      }
    } catch (cause) {
      notice.fail(cause, 'attachments');
    } finally {
      if (notice.isCurrent()) setAttachmentSaveBusy(false);
    }
  };

  const patchNodeAttachment = (nodeId: string, attachment: AttachmentView, update: Partial<Extract<NodeInputRef, { kind: 'attachment' }>> | null): void => {
    if (!draft) return;
    setDraft(current => current ? {
      ...current,
      nodes: current.nodes.map(node => {
        if (node.id !== nodeId) return node;
        const existing = node.inputRefs?.find((ref): ref is Extract<NodeInputRef, { kind: 'attachment' }> => ref.kind === 'attachment' && ref.attachment.attachmentId === attachment.attachmentId);
        const inputRefs = (node.inputRefs ?? []).filter(ref => ref.kind !== 'attachment' || ref.attachment.attachmentId !== attachment.attachmentId);
        if (update) inputRefs.push({ kind: 'attachment', attachment: { attachmentId: attachment.attachmentId, sha256: attachment.sha256 }, required: update.required ?? existing?.required ?? true, purpose: update.purpose ?? existing?.purpose ?? 'reference' });
        return { ...node, inputRefs };
      }),
    } : current);
    setAttachmentDirty(true);
  };

  const submitGoal = () => {
    setSubmitted(true);
    void start(goal, settings.workDir, settings.modelId, attachmentRefs.map(item => ({ attachmentId: item.attachmentId, sha256: item.sha256 })), attachmentSession?.sessionId, mustUseAttachments);
  };

  const requestAccess = async (stepId: string, employeeId: string): Promise<void> => {
    const key = `${stepId}:${employeeId}`;
    setRequestingKey(key);
    try {
      await requestEmployeeAccess(stepId, employeeId);
    } finally {
      setRequestingKey(current => current === key ? null : current);
    }
  };

  const refreshRequest = async (requestId: string): Promise<void> => {
    setRefreshingRequestId(requestId);
    try {
      await refreshEmployeeAccess(requestId);
    } finally {
      setRefreshingRequestId(current => current === requestId ? null : current);
    }
  };

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
          showExamples={!submitted && !planning}
          busy={busy || planning}
          value={goal}
          onChange={setGoal}
          placeholder="随心输入"
          submitLabel="开始自动编排"
          settings={settings}
          models={models}
          onSettingsChange={onSettingsChange}
          onChooseFolder={onChooseFolder}
          submitDisabled={busy || planning || attachmentsBusy || !goal.trim() || !settings.modelId || !employees.length}
          conversation={false}
          onSubmit={submitGoal}
          onAttachmentsChange={setAttachmentRefs}
          onAttachmentSessionChange={setAttachmentSession}
          onAttachmentsBusyChange={setAttachmentsBusy}
          attachmentBindingKey={attachmentBindingKey}
        />
        {attachmentRefs.length ? <label className="ent-attachment-usage"><input type="checkbox" checked={mustUseAttachments} onChange={event => setMustUseAttachments(event.target.checked)} />必须安排到至少一个步骤</label> : null}
        </section>
      ) : null}
      {draft ? (
        <AutoArrangeAnimation key={draft.id} draft={draft} employees={employees} planning={planning} planningEvents={events}>
          {draft.attachmentCandidates?.length ? <div className="ent-attachment-summary"><strong>全局附件</strong>{draft.attachmentCandidates.map(candidate => <label key={candidate.attachment.attachmentId}><input type="checkbox" checked={candidate.mustUse} disabled={planning || attachmentSaveBusy} onChange={event => { const mustUse = event.target.checked; setDraft(current => current ? { ...current, attachmentCandidates: (current.attachmentCandidates ?? []).map(item => item.attachment.attachmentId === candidate.attachment.attachmentId ? { ...item, mustUse } : item) } : current); setAttachmentDirty(true); }} />{attachmentRefs.find(item => item.attachmentId === candidate.attachment.attachmentId)?.displayName ?? candidate.attachment.attachmentId}<small>{candidate.mustUse ? '必须使用' : '可选'}</small></label>)}</div> : null}
          {draft.attachmentCandidates?.length ? <div className="ent-attachment-summary"><strong>节点附件</strong>{draft.nodes.map(node => <div key={node.id}><span>{node.title}</span>{draft.attachmentCandidates?.map(candidate => {
            const attachment = attachmentRefs.find(item => item.attachmentId === candidate.attachment.attachmentId);
            if (!attachment) return null;
            const existing = node.inputRefs?.find((ref): ref is Extract<NodeInputRef, { kind: 'attachment' }> => ref.kind === 'attachment' && ref.attachment.attachmentId === attachment.attachmentId);
            return <label key={attachment.attachmentId}><input type="checkbox" checked={Boolean(existing)} disabled={planning || attachmentSaveBusy} onChange={event => patchNodeAttachment(node.id, attachment, event.target.checked ? {} : null)} />{attachment.displayName}{existing ? <><select aria-label={`${node.title}中${attachment.displayName}的用途`} value={existing.purpose} disabled={planning || attachmentSaveBusy} onChange={event => patchNodeAttachment(node.id, attachment, { purpose: event.target.value as Extract<NodeInputRef, { kind: 'attachment' }>['purpose'] })}><option value="reference">参考</option><option value="analysis">分析</option><option value="vision">视觉</option><option value="media-source">媒体源</option></select><small><input type="checkbox" checked={existing.required} disabled={planning || attachmentSaveBusy} onChange={event => patchNodeAttachment(node.id, attachment, { required: event.target.checked })} />节点必需</small></> : null}</label>;
          })}</div>)}</div> : null}
          {attachmentDirty ? <div className="ent-attachment-save"><button type="button" className="ent-arr-second" disabled={planning || attachmentSaveBusy} onClick={() => void saveAttachmentAssignments()}>{attachmentSaveBusy ? '保存附件分配中…' : '保存附件分配'}</button><span>保存后本次编排按新分配执行</span></div> : null}
          {draft.status === 'awaiting-employee' ? (
            <section className="ent-aa-waiting">
              <div className="ent-aa-waiting-head">
                <div>
                  <h2>还缺少员工，当前编排已暂停</h2>
                  <p>申请员工不会阻塞客户端。申请通过后点击“重新检查”，系统会复用当前草稿继续匹配。</p>
                </div>
                <button type="button" className="ent-arr-primary" disabled={planning || requestingKey !== null || refreshingRequestId !== null} onClick={() => void recheck()}>
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
          {settingsOpen ? (
            <div className="ent-auto-plan">
              <RunSettingsDirectory settings={settings} onChange={onSettingsChange} onChooseFolder={onChooseFolder} />
              <RunSettingsBar settings={settings} models={models} conversation={false} onChange={onSettingsChange} />
            </div>
          ) : null}
          <footer className="ent-arr-foot">
            <button type="button" className="ent-arr-second" disabled={starting || planning || requestingKey !== null || refreshingRequestId !== null} onClick={() => { setDraft(null); setSubmitted(false); }}>重新编排</button>
            <span className="ent-arr-gap" />
            <button type="button" className="ent-arr-ghost" disabled={starting} aria-expanded={settingsOpen} onClick={() => setSettingsOpen(open => !open)}><Settings2 size={14} aria-hidden />执行设置</button>
            {draft.nodes.length > 0 && draft.status !== 'confirmed' && draft.status !== 'awaiting-employee' ? <button type="button" className="ent-arr-primary" disabled={starting || busy || attachmentDirty || attachmentSaveBusy} onClick={() => void confirmAndStart()}>{starting ? '正在启动…' : '确认并开始工作'}<ArrowRight size={15} aria-hidden /></button> : null}
          </footer>
        </AutoArrangeAnimation>
      ) : null}
      {planning && draft ? <button type="button" className="ent-arr-second" disabled={!cancellable} onClick={() => void cancel()}><X size={14} aria-hidden />取消编排</button> : null}
    </div>
  );
}
