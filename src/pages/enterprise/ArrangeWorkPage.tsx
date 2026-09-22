/**
 * 安排工作 - Phase 4 重构：会话式派活界面
 *
 * 核心改动：
 * - 删除模式选择页，进入页面直接显示会话界面
 * - 顶部轮播切换三种模式（对话式 / 自动编排 / 手动编排）
 * - 所有模式都采用对话式交互
 * - 模式切换时清空当前会话状态
 *
 * 三种模式：
 *   - 对话式：与一位员工直接沟通，边聊边做
 *   - 自动编排：AI 自动选择员工并安排工作流程
 *   - 手动编排：自己选择员工并决定协作方式
 */

import { useEffect, useState } from 'react';
import type { ArrangementDraft } from '../../shared/types';
import { AutoArrange } from '../../components/enterprise/arrange/AutoArrange';
import { ChatArrange } from '../../components/enterprise/arrange/ChatArrange';
import { ManualArrange, type ManualDraft } from '../../components/enterprise/arrange/ManualArrange';
import { ModeCarousel } from '../../components/enterprise/arrange/ModeCarousel';
import { RunSettingsDrawer } from '../../components/enterprise/arrange/RunSettingsDrawer';
import { Empty } from '../../components/enterprise/atoms';
import { defaultRunSettings, type RunSettings } from '../../features/enterprise/run-settings';
import type { ArrangeMode, SiliconEmployee, WorkDraftStep, WorkTemplate } from '../../features/enterprise/types';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
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
  const template = templateId ? workspace.templates.find(item => item.id === templateId) : undefined;

  // Phase 4: 默认进入对话式派活，而不是模式选择页
  const [currentMode, setCurrentMode] = useState<ArrangeMode>(mode === 'pick' ? 'chat' : mode);
  const [settings, setSettings] = useState<RunSettings>(defaultRunSettings);
  const [chatEmployeeId, setChatEmployeeId] = useState(employeeId ?? '');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoStartError, setAutoStartError] = useState<string | null>(null);
  /** 从常用工作 / 复制为新工作带进来的初始内容。用过就从 workspace 里清掉。 */
  const [seed, setSeed] = useState<{ title?: string; goal?: string; steps: WorkDraftStep[]; confirmedInputs?: string[] } | null>(null);
  const [seedNo, setSeedNo] = useState(0);

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

  // 模式切换时清空状态
  const handleModeSwitch = (newMode: ArrangeMode) => {
    setCurrentMode(newMode);
    setAutoStartError(null);
    setChatEmployeeId('');
    setSettings(defaultRunSettings);
    workspace.navigate({ name: 'arrange', mode: newMode });
  };

  // 同步 URL 模式变化
  useEffect(() => {
    if (mode !== 'pick' && mode !== currentMode) {
      setCurrentMode(mode);
    }
  }, [mode, currentMode]);

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
    <div className="ent-arr">
      {/* Phase 4: 顶部模式轮播切换器 */}
      <ModeCarousel currentMode={currentMode} onSwitch={handleModeSwitch} />

      {autoStartError ? <div role="alert" className="workspace-inline-error">{autoStartError}</div> : null}

      {/* 会话界面区域 - 根据当前模式渲染对应组件 */}
      <div className="ent-arr-view" key={`${currentMode}-${employeeId ?? ''}-${seedNo}`}>
        {currentMode === 'chat' ? (
          <ChatArrange
            employees={employees}
            busy={workspace.busy}
            employeeId={chatEmployeeId}
            onEmployeeChange={id => {
              setChatEmployeeId(id);
              setSettings(current => ({ ...current, modelId: employees.find(item => item.id === id)?.allowedModels[0] ?? '' }));
            }}
            onOpenSettings={() => setSettingsOpen(true)}
            onStart={startChat}
          />
        ) : null}

        {currentMode === 'auto' ? (
          <AutoArrange
            employees={employees}
            workDir={settings.workDir}
            busy={workspace.busy}
            onChooseFolder={async () => {
              const path = await workspace.chooseFolder();
              if (path) setSettings(current => ({ ...current, workDir: path }));
              return path;
            }}
            onOpenSettings={() => setSettingsOpen(true)}
            onStart={startAuto}
          />
        ) : null}

        {currentMode === 'manual' ? (
          <ManualArrange
            key={`${templateId ?? 'blank'}-${seedNo}`}
            employees={employees}
            busy={workspace.busy}
            seed={manualSeed}
            onOpenSettings={() => setSettingsOpen(true)}
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
            />
          ) : null}
      </div>

      {settingsOpen ? (
        <RunSettingsDrawer
          settings={settings}
          conversation={currentMode === 'chat'}
          models={currentMode === 'chat' ? employees.find(item => item.id === chatEmployeeId)?.allowedModels ?? [] : (employees[0]?.allowedModels ?? []).filter(model => employees.every(item => item.allowedModels.includes(model)))}
          onChange={patch => setSettings(current => ({ ...current, ...patch }))}
          onChooseFolder={workspace.chooseFolder}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </div>
  );
}
