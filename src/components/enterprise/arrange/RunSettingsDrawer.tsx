/**
 * 编排输入区的运行参数控件。
 * 视觉上嵌入 Codex/Claude 风格的输入框，不再单独显示“运行设置”标题或右侧抽屉。
 */

import { FolderOpen } from 'lucide-react';
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

export function RunSettingsDirectory({ settings, onChange, onChooseFolder }: DirectoryProps) {
  return (
    <button
      type="button"
      className="ent-rs-directory"
      title={settings.workDir || '选择本次工作的目录'}
      onClick={() => void onChooseFolder().then(path => { if (path) onChange({ workDir: path }); })}
    >
      <FolderOpen size={16} aria-hidden />
      <span>{directoryLabel(settings.workDir)}</span>
    </button>
  );
}

export function RunSettingsBar({ settings, models, conversation = false, onChange }: SharedProps) {
  const modelLabel = settings.modelId || (conversation ? models[0] : '') || '模型';
  const permission = RUN_PERMISSIONS.find(item => item.id === settings.permissions.preset);

  return (
    <div className="ent-rs-inline">
      <label className="ent-rs-compact ent-rs-permission" title="访问权限">
        <span className="sr-only">访问权限</span>
        <select
          aria-label="访问权限"
          value={settings.permissions.preset}
          onChange={event => onChange({ permissions: { ...settings.permissions, preset: event.target.value as RunSettings['permissions']['preset'] } })}
        >
          {RUN_PERMISSIONS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
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
      <span className="sr-only">当前权限：{permission?.label ?? '只读'}</span>
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
