/**
 * 安排工作。四个画面，一条主线：
 *
 *   安排工作（选方式）
 *        ├── 对话式    一位同事，边聊边做
 *        ├── 自动编排  说清目标，系统自己选人并排出流程
 *        └── 自己编排  自己选人、自己决定先后
 *
 * 这一层只负责三件事：在四个画面之间切换（带一层很轻的淡出淡入）、
 * 收着「执行设置」这个抽屉、把三种方式最后的结果交给 workspace 去真的开工。
 * 具体的界面在 components/enterprise/arrange/ 下面各自一个文件。
 *
 * 运行设置共享同一状态；自动编排也可从输入栏选择工作目录。
 */

import { ChevronLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ArrangementDraft } from '../../shared/types';
import { AutoArrange } from '../../components/enterprise/arrange/AutoArrange';
import { ChatArrange } from '../../components/enterprise/arrange/ChatArrange';
import { ManualArrange, type ManualDraft } from '../../components/enterprise/arrange/ManualArrange';
import { ModeCards } from '../../components/enterprise/arrange/ModeCards';
import { RunSettingsDrawer } from '../../components/enterprise/arrange/RunSettingsDrawer';
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
  const template = templateId ? workspace.templates.find(item => item.id === templateId) : undefined;

  const [settings, setSettings] = useState<RunSettings>(defaultRunSettings);
  const [chatEmployeeId, setChatEmployeeId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    setChatEmployeeId('');
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
    <div className="ent-arr">
      {autoStartError ? <div role="alert" className="workspace-inline-error">{autoStartError}</div> : null}
      {mode === 'pick' ? (
        <div className={`ent-arr-view${leaving ? ' leaving' : ''}`}>
          <ModeCards leaving={leaving} onPick={go} />
        </div>
      ) : (
        // key 带上 employeeId：从员工页点进「对话式」时 mode 没变，
        // 不带上的话组件不会重挂，预选的同事就换不过去。
        <div className="ent-arr-view" key={`${mode}-${employeeId ?? ''}`}>
          <button type="button" className="ent-arr-back" onClick={() => workspace.navigate({ name: 'arrange' })}>
            <ChevronLeft size={14} aria-hidden />
            安排工作
          </button>

          {mode === 'chat' ? (
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

          {mode === 'auto' ? (
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

          {mode === 'manual' ? (
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
      )}

      {settingsOpen ? (
        <RunSettingsDrawer
          settings={settings}
          conversation={mode === 'chat'}
          models={mode === 'chat' ? employees.find(item => item.id === chatEmployeeId)?.allowedModels ?? [] : (employees[0]?.allowedModels ?? []).filter(model => employees.every(item => item.allowedModels.includes(model)))}
          onChange={patch => setSettings(current => ({ ...current, ...patch }))}
          onChooseFolder={workspace.chooseFolder}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </div>
  );
}
