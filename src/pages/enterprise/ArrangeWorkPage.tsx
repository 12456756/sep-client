/**
 * 安排工作工作台：顶层只保留「会话 / 编排」两个模式。
 * 编排内部再切换「自动 / 手动」，运行设置嵌入各自输入/操作区。
 */

import { useEffect, useState } from 'react';
import type { ArrangementDraft } from '../../shared/types';
import { AutoArrange } from '../../components/enterprise/arrange/AutoArrange';
import { ChatArrange } from '../../components/enterprise/arrange/ChatArrange';
import { ManualArrange, type ManualDraft } from '../../components/enterprise/arrange/ManualArrange';
import { Empty } from '../../components/enterprise/atoms';
import { defaultRunSettings, type RunSettings } from '../../features/enterprise/run-settings';
import type { ArrangeMode, SiliconEmployee, WorkDraftStep, WorkTemplate } from '../../features/enterprise/types';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import { usePrefersReducedMotion } from '../../features/enterprise/use-reduced-motion';
import { createDraftStep } from '../../features/enterprise/work-graph';

interface Props {
  workspace: EnterpriseWorkspace;
  templateId?: string;
  employeeId?: string;
  mode: ArrangeMode;
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

export function ArrangeWorkPage({ workspace, templateId, employeeId, mode }: Props) {
  /** 只有现在能派活的同事参与安排。暂时不可用的员工选了也开不了工。 */
  const employees = workspace.myEmployees.filter(item => item.availability !== 'unavailable');
  const availableModels = Array.from(new Set(employees.flatMap(item => item.allowedModels)));
  const template = templateId ? workspace.templates.find(item => item.id === templateId) : undefined;

  const [settings, setSettings] = useState<RunSettings>(defaultRunSettings);
  const [chatEmployeeId, setChatEmployeeId] = useState(employeeId ?? '');
  const activeMode = mode === 'pick' ? 'chat' : mode;
  const isOrchestration = activeMode === 'auto' || activeMode === 'manual';
  const [autoStartError, setAutoStartError] = useState<string | null>(null);
  /** 正在淡出的目标画面。给「点了卡片但还没换页」这 200ms 用。 */
  const [leaving, setLeaving] = useState<ArrangeMode | null>(null);
  /** 从常用工作 / 复制为新工作带进来的初始内容。用过就从 workspace 里清掉。 */
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
    setAutoStartError(null);
    setChatEmployeeId(employeeId ?? '');
    setSettings(current => ({ ...current, modelId: '' }));
  }, [mode, employeeId]);

  const go = (next: ArrangeMode) => {
    if (reduced) { workspace.navigate({ name: 'arrange', mode: next }); return; }
    setLeaving(next);
    window.setTimeout(() => workspace.navigate({ name: 'arrange', mode: next }), 200);
  };

  const startAuto = async (draft: ArrangementDraft): Promise<ArrangementDraft> => {
    setAutoStartError(null);
    try {
      const updated = await window.electronAPI.updateArrangementDraft({
        draftId: draft.id, expectedRevision: draft.revision,
        document: {
          schemaVersion: draft.schemaVersion, mode: draft.mode, title: draft.title, goal: draft.goal,
          confirmedInputs: draft.confirmedInputs, sharedSkillIds: draft.sharedSkillIds,
          conversation: draft.conversation, lastPlanning: draft.lastPlanning,
          nodes: draft.nodes.map(node => ({ ...node, modelId: settings.modelId || node.modelId })),
          workspace: { ...draft.workspace, path: settings.workDir.trim() || draft.workspace.path },
          permissions: { ...settings.permissions },
        },
      });
      if (!updated.success || !updated.draft) throw new Error(updated.error?.message || '保存执行设置失败');
      draft = updated.draft;
      const preflight = await window.electronAPI.preflightArrangementDraft({ draftId: draft.id, expectedRevision: draft.revision });
      if (!preflight.success || !preflight.preflight?.canStart) {
        throw new Error(preflight.error?.message || preflight.preflight?.blockingIssues.join('；') || '运行前检查失败');
      }
      const result = await window.electronAPI.confirmAndStartArrangement({ draftId: draft.id, expectedRevision: draft.revision, idempotencyKey: crypto.randomUUID() });
      if (!result.success || !result.execution) throw new Error(result.error?.message || '启动工作失败');
      workspace.navigate({ name: 'work', workId: result.execution.id });
    } catch (cause) {
      setAutoStartError(cause instanceof Error ? cause.message : '启动工作失败');
    }
    return draft;
  };

  const startManual = (draft: ManualDraft) => {
    void workspace.arrangeWork({ ...draft, templateId: template?.id, workDir: settings.workDir, modelId: settings.modelId, permissions: settings.permissions, sharedSkillIds: [] });
  };

  const startChat = (id: string, text: string) => {
    void workspace.startConversation(id, text, { workDir: settings.workDir, modelId: settings.modelId, permissions: settings.permissions });
  };

  if (!workspace.myEmployees.length) {
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
    <div className={`ent-arr ent-arr-mode-${activeMode}`}>
      <div className="ent-arr-workbench-head">
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
      </div>

      {autoStartError ? <div role="alert" className="workspace-inline-error">{autoStartError}</div> : null}
      <div className={`ent-arr-view${leaving ? ' leaving' : ''}`} key={`${activeMode}-${employeeId ?? ''}`}>
        {activeMode === 'chat' ? (
          <ChatArrange
            employees={employees}
            busy={workspace.busy}
            employeeId={chatEmployeeId}
            onEmployeeChange={id => {
              setChatEmployeeId(id);
            }}
            onStart={startChat}
            settings={settings}
            models={availableModels}
            onSettingsChange={patch => setSettings(current => ({ ...current, ...patch }))}
            onChooseFolder={workspace.chooseFolder}
          />
        ) : null}

        {activeMode === 'auto' ? (
          <AutoArrange
            employees={employees}
            busy={workspace.busy}
            onStart={startAuto}
            settings={settings}
            models={(employees[0]?.allowedModels ?? []).filter(model => employees.every(item => item.allowedModels.includes(model)))}
            onSettingsChange={patch => setSettings(current => ({ ...current, ...patch }))}
            onChooseFolder={workspace.chooseFolder}
          />
        ) : null}

        {activeMode === 'manual' ? (
          <ManualArrange
            key={`${templateId ?? 'blank'}-${seedNo}`}
            employees={employees}
            busy={workspace.busy}
            seed={manualSeed}
            onSave={draft => {
              workspace.saveFlow({
                name: draft.title,
                goal: draft.goal,
                version: 2,
                steps: draft.steps,
                confirmedInputs: draft.confirmedInputs,
                sharedSkillIds: [],
              });
            }}
            onStart={startManual}
            settings={settings}
            models={(employees[0]?.allowedModels ?? []).filter(model => employees.every(item => item.allowedModels.includes(model)))}
            onSettingsChange={patch => setSettings(current => ({ ...current, ...patch }))}
            onChooseFolder={workspace.chooseFolder}
          />
        ) : null}
      </div>

    </div>
  );
}
