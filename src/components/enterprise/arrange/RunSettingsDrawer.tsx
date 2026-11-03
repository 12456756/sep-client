/**
 * 编排输入区的运行参数控件。
 * 视觉上嵌入 Codex/Claude 风格的输入框，不再单独显示“运行设置”标题或右侧抽屉。
 */

import { FolderOpen, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ModelSelector } from '../ModelSelector';
import { RUN_PERMISSIONS, type RunSettings } from '../../../features/enterprise/run-settings';
import { formatDirectoryPath } from '../../../shared/path-display';

interface SharedProps {
  settings: RunSettings;
  models: string[];
  conversation?: boolean;
  portalWithinControl?: boolean;
  onChange: (patch: Partial<RunSettings>) => void;
}

interface DirectoryProps {
  settings: RunSettings;
  onChange: (patch: Partial<RunSettings>) => void;
  onChooseFolder: (currentPath?: string) => Promise<string | null>;
  allowedPresets?: RunSettings['permissions']['preset'][];
}

interface Props extends SharedProps, DirectoryProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

function directoryLabel(workDir: string): string {
  return workDir.trim() ? formatDirectoryPath(workDir) : '选择目录';
}

/**
 * 目录按钮旁的下拉：本次工作的运行环境。
 *
 * 权限预设与审批开关原先挤在输入框底栏，与模型选择并排。它们在界面上表现为
 * 一个「只读」下拉和一个无可见文字的空方框（审批开关只有 sr-only 标签），
 * 既占位又读不懂。这里把两者移到目录行——语义上它们和「选哪个目录」同属
 * 「这次工作在什么环境下跑」，放在一起才讲得通。
 */
export function RunSettingsDirectory({ settings, onChange, onChooseFolder, allowedPresets }: DirectoryProps) {
  const [defaultWorkspacePath, setDefaultWorkspacePath] = useState('');
  const permission = RUN_PERMISSIONS.find(item => item.id === settings.permissions.preset);
  const autoApprove = settings.permissions.approvalMode === 'auto-approve';

  useEffect(() => {
    let changedDuringLoad = false;
    const onDefaultWorkspaceChanged = (event: Event) => {
      changedDuringLoad = true;
      setDefaultWorkspacePath((event as CustomEvent<string | null>).detail ?? '');
    };
    if (settings.workDir.trim()) {
      setDefaultWorkspacePath('');
    }
    let mounted = true;
    void window.electronAPI.getDefaultWorkspaceDirectory().then(result => {
      if (mounted && !changedDuringLoad && result.success && result.path) setDefaultWorkspacePath(result.path);
    }).catch(() => undefined);
    window.addEventListener('default-workspace-directory-changed', onDefaultWorkspaceChanged);
    return () => {
      mounted = false;
      window.removeEventListener('default-workspace-directory-changed', onDefaultWorkspaceChanged);
    };
  }, [settings.workDir]);

  const displayPath = settings.workDir.trim() || defaultWorkspacePath;

  return (
    <div className="ent-rs-env">
      <button
        type="button"
        className="ent-rs-directory"
        title={displayPath || '选择本次工作的目录'}
        onClick={() => void onChooseFolder(settings.workDir).then(path => { if (path) onChange({ workDir: path }); })}
      >
        <FolderOpen size={16} aria-hidden />
        <span>{directoryLabel(displayPath)}</span>
      </button>

      <label className="ent-rs-compact ent-rs-permission" title={permission?.hint ?? '访问权限'}>
        <ShieldCheck size={14} aria-hidden />
        <select
          aria-label="访问权限"
          value={settings.permissions.preset}
          onChange={event => onChange({ permissions: { ...settings.permissions, preset: event.target.value as RunSettings['permissions']['preset'] } })}
        >
          {RUN_PERMISSIONS.filter(item => !allowedPresets || allowedPresets.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
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

export function RunSettingsBar({ settings, models, conversation = false, portalWithinControl = false, onChange }: SharedProps) {
  const modelLabel = settings.modelId || (conversation ? models[0] : '') || '模型';

  return (
    <div className="ent-rs-inline">
      <ModelSelector
        portalWithinControl={portalWithinControl}
        models={models}
        value={models.includes(settings.modelId) ? settings.modelId : conversation ? models[0] ?? '' : ''}
        title={modelLabel}
        allowEmpty={!conversation}
        onChange={modelId => onChange({ modelId })}
      />
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
