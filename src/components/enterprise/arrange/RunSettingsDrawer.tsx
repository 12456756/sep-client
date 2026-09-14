/**
 * 执行设置。从右侧滑出的抽屉，不是主页面上的一块 ——
 * 工作目录、模型、权限都是「需要时才改」的东西，默认不该占第一视觉层。
 *
 * 三段固定顺序：在哪做（工作目录）→ 用什么做（模型）→ 允许做什么（权限）。
 * 开关只有紫（开）和浅灰（关）两种，关闭不用红色：关掉不是错误状态。
 */

import { FolderOpen, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { RUN_PERMISSIONS, type RunPermissionId, type RunSettings } from '../../../features/enterprise/run-settings';

interface Props {
  settings: RunSettings;
  mode: 'pick' | 'chat' | 'auto' | 'manual';
  /** 这些员工被允许使用的模型的并集。空数组表示企业没有开放选择。 */
  models: string[];
  onChange: (patch: Partial<RunSettings>) => void;
  onChooseFolder: () => Promise<string | null>;
  onClose: () => void;
}

export function RunSettingsDrawer({ settings, mode, models, onChange, onChooseFolder, onClose }: Props) {
  const panel = useRef<HTMLElement>(null);

  // 抽屉是个临时层：Esc 关掉，打开时焦点进到面板里，否则键盘用户还留在页面上。
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    panel.current?.querySelector<HTMLElement>('input, select, button')?.focus();
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  const selectPreset = (id: RunPermissionId) => onChange({ permissionPreset: id });

  return (
    <>
      <div className="ent-rs-back" onClick={onClose} aria-hidden />
      <aside className="ent-rs" role="dialog" aria-modal="true" aria-label="执行设置" ref={panel}>
        <header className="ent-rs-head">
          <h2>执行设置</h2>
          <button type="button" className="ent-rs-close" onClick={onClose} aria-label="关闭执行设置">
            <X size={15} aria-hidden />
          </button>
        </header>

        <div className="ent-rs-body">
          <div className="ent-rs-field">
            <label htmlFor="ent-rs-dir">工作目录</label>
            <div className="ent-rs-path">
              <input
                id="ent-rs-dir"
                className="ent-rs-input"
                value={settings.workDir}
                onChange={event => onChange({ workDir: event.target.value })}
                placeholder="输入或选择工作目录"
              />
              <button
                type="button"
                className="ent-rs-pick"
                onClick={() => void onChooseFolder().then(path => { if (path) onChange({ workDir: path }); })}
                aria-label="选择工作目录"
              >
                <FolderOpen size={14} aria-hidden />
              </button>
            </div>
            <small>员工产生的文件都放在这里。不确定就留空。</small>
          </div>

          <div className="ent-rs-field">
            {mode !== 'auto' ? <>
              <label htmlFor="ent-rs-model">模型</label>
              <select id="ent-rs-model" className="ent-rs-input" value={settings.model} disabled={!models.length} onChange={event => onChange({ model: event.target.value })}>
                <option value="">{models.length ? '请选择模型' : '暂无可选模型'}</option>
                {models.map(model => <option key={model} value={model}>{model}</option>)}
              </select>
              <small>选择这次工作使用的模型。</small>
            </> : <>
              <span className="ent-rs-label">模型选择策略</span>
              <div className="ent-rs-presets" role="radiogroup" aria-label="选择模型策略">
                {([{ id: 'per-employee', label: '按员工选择', hint: '每位员工使用其允许模型列表中的首个模型' }, { id: 'same-model', label: '尽量统一模型', hint: '优先使用共同允许的模型；没有共同模型时按员工选择' }] as const).map(item => (
                  <label className={'ent-rs-preset' + (settings.modelStrategy === item.id ? ' on' : '')} key={item.id}>
                    <input type="radio" name="model-strategy" checked={settings.modelStrategy === item.id} onChange={() => onChange({ modelStrategy: item.id })} />
                    <span><strong>{item.label}</strong><small>{item.hint}</small></span>
                  </label>
                ))}
              </div>
            </>}
          </div>

          <div className="ent-rs-field">
            <span className="ent-rs-label">权限</span>
            <div className="ent-rs-presets" role="radiogroup" aria-label="选择权限级别">
              {RUN_PERMISSIONS.map(item => (
                <label className={`ent-rs-preset${settings.permissionPreset === item.id ? ' on' : ''}`} key={item.id}>
                  <input type="radio" name="run-permission" checked={settings.permissionPreset === item.id} onChange={() => selectPreset(item.id)} />
                  <span><strong>{item.label}</strong><small>{item.hint}</small></span>
                </label>
              ))}
            </div>
            <small>权限级别决定员工可以访问和修改的范围。</small>
            <label className="ent-rs-danger-option">
              <input type="checkbox" checked={settings.allowWithoutApproval} onChange={event => onChange({ allowWithoutApproval: event.target.checked })} />
              <span><strong>无需用户确认，自动执行高风险动作</strong><small>仅对所选权限范围内的写入、编辑和命令执行免确认，不会扩大权限范围。</small></span>
            </label>
          </div>
        </div>
      </aside>
    </>
  );
}


