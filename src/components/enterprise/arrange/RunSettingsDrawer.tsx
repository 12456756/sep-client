/**
 * 编排输入区的运行参数控件。
 * 视觉上嵌入 Codex/Claude 风格的输入框，不再单独显示“运行设置”标题或右侧抽屉。
 */

import { FolderOpen, ShieldCheck } from 'lucide-react';
import { RUN_PERMISSIONS, type RunSettings } from '../../../features/enterprise/run-settings';

interface SharedProps {
  settings: RunSettings;
  models: string[];
  conversation?: boolean;
  onChange: (patch: Partial<RunSettings>) => void;
}

interface DirectoryProps {
  settings: RunSettings;
  onChange: (patch: Partial<RunSettings>) => void;
  onChooseFolder: () => Promise<string | null>;
}

interface Props extends SharedProps, DirectoryProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

function directoryLabel(workDir: string): string {
  return workDir.trim() ? workDir.split(/[\\/]/).filter(Boolean).at(-1) ?? '选择目录' : '选择目录';
}

/**
 * 目录按钮旁的下拉：本次工作的运行环境。
 *
 * 权限预设与审批开关原先挤在输入框底栏，与模型选择并排。它们在界面上表现为
 * 一个「只读」下拉和一个无可见文字的空方框（审批开关只有 sr-only 标签），
 * 既占位又读不懂。这里把两者移到目录行——语义上它们和「选哪个目录」同属
 * 「这次工作在什么环境下跑」，放在一起才讲得通。
 */
export function RunSettingsDirectory({ settings, onChange, onChooseFolder }: DirectoryProps) {
  const permission = RUN_PERMISSIONS.find(item => item.id === settings.permissions.preset);
  const autoApprove = settings.permissions.approvalMode === 'auto-approve';

  return (
    <div className="ent-rs-env">
      <button
        type="button"
        className="ent-rs-directory"
        title={settings.workDir || '选择本次工作的目录'}
        onClick={() => void onChooseFolder().then(path => { if (path) onChange({ workDir: path }); })}
      >
        <FolderOpen size={16} aria-hidden />
        <span>{directoryLabel(settings.workDir)}</span>
      </button>

      <label className="ent-rs-compact ent-rs-permission" title={permission?.hint ?? '访问权限'}>
        <ShieldCheck size={14} aria-hidden />
        <select
          aria-label="访问权限"
          value={settings.permissions.preset}
          onChange={event => onChange({ permissions: { ...settings.permissions, preset: event.target.value as RunSettings['permissions']['preset'] } })}
        >
          {RUN_PERMISSIONS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>

      {/* 审批开关带可见文字：原先只靠 sr-only 标签，渲染出来是个没有说明的空方框 */}
      <label className="ent-rs-compact ent-rs-approval" title="开启后，本次工作中的工具调用不再逐次向你确认">
        <input
          type="checkbox"
          checked={autoApprove}
          onChange={event => onChange({ permissions: {
            ...settings.permissions,
            approvalMode: event.target.checked ? 'auto-approve' : 'confirm-each',
          } })}
        />
        <span>自动放行</span>
      </label>
    </div>
  );
}

export function RunSettingsBar({ settings, models, conversation = false, onChange }: SharedProps) {
  const modelLabel = settings.modelId || (conversation ? models[0] : '') || '模型';

  return (
    <div className="ent-rs-inline">
      <label className="ent-rs-compact ent-rs-model" title={modelLabel}>
        <span className="sr-only">模型</span>
        <select
          aria-label="模型"
          value={models.includes(settings.modelId) ? settings.modelId : conversation ? models[0] ?? '' : ''}
          disabled={!models.length}
          onChange={event => onChange({ modelId: event.target.value })}
        >
          {!models.length ? <option value="">模型</option> : !conversation ? <option value="">模型</option> : null}
          {models.map(model => <option key={model} value={model}>{model}</option>)}
        </select>
      </label>
    </div>
  );
}

/** 兼容旧调用方；新的页面将目录按钮和底部控件分别嵌入输入组件。 */
export function RunSettingsDrawer(props: Props) {
  return (
    <div className="ent-rs-legacy">
      <RunSettingsDirectory settings={props.settings} onChange={props.onChange} onChooseFolder={props.onChooseFolder} />
      <RunSettingsBar settings={props.settings} models={props.models} conversation={props.conversation} onChange={props.onChange} />
    </div>
  );
}
