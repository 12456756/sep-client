/**
 * 安排工作工作台：顶层只保留「会话 / 编排」两个模式。
 * 编排内部再切换「自动 / 手动」，运行设置嵌入各自输入/操作区。
 */

import { useEffect, useState, useSyncExternalStore, useCallback, useRef } from 'react';
import { useOperationFeedback } from '../../components/feedback/use-operation-feedback';
import { recoverDraftRevisionConflict, responseError } from '../../shared/arrangement-feedback';
import type { ArrangementDraft } from '../../shared/types';
import { AutoArrange } from '../../components/enterprise/arrange/AutoArrange';
import { ChatArrange } from '../../components/enterprise/arrange/ChatArrange';
import { ManualArrange, type ManualDraft } from '../../components/enterprise/arrange/ManualArrange';
import { Empty } from '../../components/enterprise/atoms';
import { defaultAutoRunSettings, defaultConversationRunSettings, defaultRunSettings, type RunSettings } from '../../features/enterprise/run-settings';
import type { ArrangeMode, SiliconEmployee, WorkDraftStep, WorkTemplate } from '../../features/enterprise/types';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import { usePrefersReducedMotion } from '../../features/enterprise/use-reduced-motion';
import { createDraftStep } from '../../features/enterprise/work-graph';
import type { AttachmentImportSession, AttachmentView } from '../../shared/attachment-contracts';
import { generalAssistant, GENERAL_ASSISTANT_ID } from '../../features/enterprise/general-assistant';
import { useModelPreference } from '../../components/workspace/model-preference-scope';
import { useTaskModel } from '../../features/enterprise/use-task-model';

interface Props {
  planningDraftId?: string;
  workspace: EnterpriseWorkspace;
  templateId?: string;
  employeeId?: string;
  mode: ArrangeMode;
  onWorkCreated?: () => void;
}

/** 企业固定流程 → 一条线性的工作链。步骤内容由企业定义，员工和顺序用户可以改。 */
function stepsFromTemplate(template: WorkTemplate, employees: SiliconEmployee[]): WorkDraftStep[] {
  const steps = template.steps.map((step, index) => ({
    ...createDraftStep(template.employeeIds[index] ?? employees[index % Math.max(1, employees.length)]?.id ?? ''),
    title: step.title,
    input: step.input,
    output: step.output,
    needsConfirm: step.needsConfirm,
  }));
  return steps.map((step, index) => (index ? { ...step, dependsOn: [steps[index - 1]!.id] } : step));
}

export function ArrangeWorkPage({ workspace, templateId, employeeId, mode, onWorkCreated, planningDraftId }: Props) {
  const controller = workspace.planningController;
  const saved = useSyncExternalStore(
    useCallback(listener => controller && planningDraftId ? controller.subscribeRecord(planningDraftId, listener) : () => {}, [controller, planningDraftId]),
    useCallback(() => planningDraftId ? controller?.getRecord(planningDraftId) : undefined, [controller, planningDraftId]),
    () => undefined,
  );
  const hydrated = useRef(false);
  const latestRoute = useRef(workspace.route);
  latestRoute.current = workspace.route;
  /** 只有现在能派活的同事参与安排。暂时不可用的员工选了也开不了工。 */
  const employees = workspace.myEmployees.filter(item => item.availability !== 'unavailable');
  const orchestrationModels = (employees[0]?.allowedModels ?? []).filter(model => employees.every(item => item.allowedModels.includes(model)));
  const assistant = generalAssistant(employees);
  const chatEmployees = [assistant, ...employees];
  const template = templateId ? workspace.templates.find(item => item.id === templateId) : undefined;

  const activeMode = mode === 'pick' ? 'chat' : mode;
  const [runSettings, setSettings] = useState<RunSettings>(() => activeMode === 'auto'
    ? defaultAutoRunSettings()
    : activeMode === 'chat' ? defaultConversationRunSettings() : defaultRunSettings());
  const [chatEmployeeId, setChatEmployeeId] = useState(employeeId ?? GENERAL_ASSISTANT_ID);
  const { defaultModelId } = useModelPreference();
  const sceneModels = activeMode === 'chat'
    ? chatEmployees.find(employee => employee.id === chatEmployeeId)?.allowedModels ?? []
    : orchestrationModels;
  const taskModel = useTaskModel(`${mode}:${employeeId ?? ''}:${chatEmployeeId}`, sceneModels, defaultModelId);
  const settings = { ...runSettings, modelId: planningDraftId ? runSettings.modelId || saved?.draft.planningModelId || saved?.progress?.modelId || ''
    : activeMode === 'manual' ? runSettings.modelId : taskModel.modelId };
  useEffect(() => {
    if (!saved || hydrated.current) return;
    hydrated.current = true;
    setSettings({ ...runSettings, workDir: saved.draft.workspace.path ?? '', permissions: { ...saved.draft.permissions },
      modelId: saved.draft.planningModelId ?? saved.progress?.modelId ?? '' });
  }, [saved, runSettings]);
  const changeSettings = (patch: Partial<RunSettings>): void => {
    if (activeMode !== 'manual' && patch.modelId !== undefined) taskModel.select(patch.modelId);
    setSettings(current => ({ ...current, ...patch }));
  };
  const isOrchestration = activeMode === 'auto' || activeMode === 'manual';
  const { capture: captureFeedback } = useOperationFeedback(`${workspace.attachmentScopeKey}:${activeMode}`);
  /** 正在淡出的目标画面。给「点了卡片但还没换页」这 200ms 用。 */
  const [leaving, setLeaving] = useState<ArrangeMode | null>(null);
  /** 从常用工作带进来的初始内容，用过就从 workspace 里清掉。 */
  const [seed, setSeed] = useState<{ title?: string; goal?: string; steps: WorkDraftStep[]; confirmedInputs?: string[] } | null>(null);
  const [seedNo, setSeedNo] = useState(0);
  const reduced = usePrefersReducedMotion();

  const incoming = workspace.arrangeSeed;
  useEffect(() => {
    if (!incoming) return;
    setSeed({
      title: incoming.title,
      goal: incoming.goal,
      steps: incoming.steps.map(step => ({ ...step })),
      confirmedInputs: incoming.confirmedInputs,
    });
    setSeedNo(value => value + 1);
    workspace.seedArrange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  // 换画面时把上一屏的淡出状态清掉，否则返回时这一屏是半透明的。
  useEffect(() => {
    setLeaving(null);
    if (planningDraftId) return;
    setChatEmployeeId(employeeId ?? GENERAL_ASSISTANT_ID);
    setSettings(current => ({ ...current, modelId: '' }));
  }, [mode, employeeId, activeMode, planningDraftId]);

  useEffect(() => {
    if (planningDraftId) return;
    if (activeMode === 'auto') {
      setSettings(current => ({ ...current, permissions: defaultAutoRunSettings().permissions }));
    } else if (activeMode === 'chat') {
      setSettings(current => ({ ...current, permissions: defaultConversationRunSettings().permissions }));
    }
  }, [activeMode, planningDraftId]);

  const go = (next: ArrangeMode) => {
    if (reduced) { workspace.navigate({ name: 'arrange', mode: next }); return; }
    setLeaving(next);
    window.setTimeout(() => workspace.navigate({ name: 'arrange', mode: next }), 200);
  };

  const startAuto = async (draft: ArrangementDraft): Promise<ArrangementDraft> => {
    const notice = captureFeedback();
    try {
      const updated = await window.electronAPI.updateArrangementExecutionSettings({
        draftId: draft.id, expectedRevision: draft.revision,
        settings: {
          modelId: settings.modelId || undefined,
          workDir: settings.workDir.trim() || null,
          permissions: { ...settings.permissions },
        },
      });
      if (!notice.isCurrent()) return draft;
      if (!updated.success || !updated.draft) throw responseError(updated, 'settings');
      draft = updated.draft;
      controller?.updateDraft(draft);
      const preflight = await window.electronAPI.preflightArrangementDraft({ draftId: draft.id, expectedRevision: draft.revision });
      if (!notice.isCurrent()) return draft;
      if (!preflight.success || !preflight.preflight?.canStart) {
        throw responseError({ error: preflight.error ?? (preflight.preflight?.message ? { message: preflight.preflight.message } : undefined) }, 'preflight');
      }
      const result = await window.electronAPI.confirmAndStartArrangement({ draftId: draft.id, expectedRevision: draft.revision, idempotencyKey: crypto.randomUUID() });
      if (!result.success || !result.execution) throw responseError(result, 'start');
      await controller?.load(draft.id);
      if (!notice.isCurrent()) return draft;
      const current = latestRoute.current;
      if (current.name === 'work' && current.workId === draft.id) workspace.replaceRoute({ name: 'work', workId: result.execution.id });
    } catch (cause) {
      if (!notice.isCurrent()) return draft;
      if (controller && await recoverDraftRevisionConflict(cause, () => controller.load(draft.id), error => notice.fail(error, 'read'))) {
        return controller.getRecord(draft.id)?.draft ?? draft;
      }
      notice.fail(cause, 'start');
    }
    return draft;
  };

  const startManual = (draft: ManualDraft) => {
    void workspace.arrangeWork({ ...draft, templateId: template?.id, workDir: settings.workDir, modelId: settings.modelId, permissions: settings.permissions, sharedSkillIds: [], attachmentSessionId: draft.attachmentSession?.sessionId, attachmentCandidates: draft.attachmentRefs?.map(item => ({ attachment: { attachmentId: item.attachmentId, sha256: item.sha256 }, mustUse: draft.mustUseAttachments ?? true })) }).then(created => { if (created) onWorkCreated?.(); });
  };

  const startChat = (id: string, text: string, attachments: AttachmentView[], session: AttachmentImportSession | null) => {
    if (!settings.modelId || !sceneModels.includes(settings.modelId)) return;
    taskModel.commit();
    void workspace.startConversation(id, text, { workDir: settings.workDir, modelId: settings.modelId, permissions: settings.permissions, attachmentSessionId: session?.sessionId, attachmentRefs: attachments.map(item => ({ attachmentId: item.attachmentId, sha256: item.sha256 })) }).then(created => { if (created) onWorkCreated?.(); });
  };

  if (!workspace.myEmployees.length && !planningDraftId) {
    return (
      <div className="ent-arr">
        <Empty title="还没有可以安排的硅基员工">企业管理员给你分配员工后，就可以在这里安排工作了。</Empty>
      </div>
    );
  }

  const manualSeed = seed ?? (template
    ? { title: template.name, goal: template.goal, steps: stepsFromTemplate(template, employees), confirmedInputs: [] }
    : null);

  return (
    <div className={`ent-arr ent-arr-mode-${activeMode}${planningDraftId ? ' ent-arr-restored' : ''}`}>
      {!planningDraftId && <div className="ent-arr-workbench-head">
        <div className="ent-arr-mode-switch" role="tablist" aria-label="安排工作模式">
          <button
            type="button"
            role="tab"
            aria-selected={!isOrchestration}
            className={!isOrchestration ? 'active' : undefined}
            onClick={() => go('chat')}
          >
            会话
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isOrchestration}
            className={isOrchestration ? 'active' : undefined}
            onClick={() => go(activeMode === 'manual' ? 'manual' : 'auto')}
          >
            编排
          </button>
        </div>
        {isOrchestration ? (
          <div className="ent-arr-submode" role="tablist" aria-label="编排方式">
            <button type="button" role="tab" aria-selected={activeMode === 'auto'} className={activeMode === 'auto' ? 'active' : undefined} onClick={() => go('auto')}>自动</button>
            <button type="button" role="tab" aria-selected={activeMode === 'manual'} className={activeMode === 'manual' ? 'active' : undefined} onClick={() => go('manual')}>手动</button>
          </div>
        ) : null}
      </div>}

      <div className={`ent-arr-view${leaving ? ' leaving' : ''}`} key={`${activeMode}-${employeeId ?? ''}`}>
        {activeMode === 'chat' ? (
          <ChatArrange
            employees={chatEmployees}
            busy={workspace.busy}
            employeeId={chatEmployeeId}
            attachmentBindingKey={workspace.attachmentScopeKey}
            onEmployeeChange={id => {
              setChatEmployeeId(id);
            }}
            onStart={startChat}
            settings={settings}
            models={sceneModels}
            onSettingsChange={changeSettings}
            onChooseFolder={workspace.chooseFolder}
          />
        ) : null}

        {activeMode === 'auto' ? (
          <AutoArrange
            recordId={planningDraftId}
            onRecorded={draftId => {
              if (latestRoute.current.name === 'arrange') {
                workspace.navigate({ name: 'work', workId: draftId });
              }
              onWorkCreated?.();
            }}
            employees={employees}
            busy={workspace.busy}
            onStart={startAuto}
            onPlanningStart={taskModel.commit}
            attachmentBindingKey={workspace.attachmentScopeKey}
            settings={settings}
            models={orchestrationModels}
            onSettingsChange={changeSettings}
            onChooseFolder={workspace.chooseFolder}
          />
        ) : null}

        {activeMode === 'manual' ? (
          <ManualArrange
            key={`${templateId ?? 'blank'}-${seedNo}`}
            employees={employees}
            busy={workspace.busy}
            attachmentBindingKey={workspace.attachmentScopeKey}
            seed={manualSeed}
            onSave={draft => {
              return workspace.saveFlow({
                name: draft.title,
                goal: draft.goal,
                version: 2,
                steps: draft.steps.map(step => ({ ...step, inputRefs: step.inputRefs?.filter(ref => ref.kind !== 'attachment') })),
                confirmedInputs: draft.confirmedInputs,
                sharedSkillIds: [],
              });
            }}
            onStart={startManual}
            settings={settings}
            models={orchestrationModels}
            onSettingsChange={changeSettings}
            onChooseFolder={workspace.chooseFolder}
          />
        ) : null}
      </div>

    </div>
  );
}
