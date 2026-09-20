/**
 * 执行设置。从右侧滑出的抽屉，不是主页面上的一块 ——
 * 工作目录、模型、权限都是「需要时才改」的东西，默认不该占第一视觉层。
 *
 * 三段固定顺序：在哪做（工作目录）→ 用什么做（模型）→ 允许做什么（权限）。
 * 开关只有紫（开）和浅灰（关）两种，关闭不用红色：关掉不是错误状态。
 */

import { FolderOpen, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { RUN_PERMISSIONS, type RunSettings } from '../../../features/enterprise/run-settings';

interface Props {
  settings: RunSettings;
  /** 对话使用所选员工的模型；多员工编排只提供共同可用模型作为统一覆盖。 */
  models: string[];
  conversation?: boolean;
  onChange: (patch: Partial<RunSettings>) => void;
  onChooseFolder: () => Promise<string | null>;
  onClose: () => void;
}

export function RunSettingsDrawer({ settings, models, conversation = false, onChange, onChooseFolder, onClose }: Props) {
  const panel = useRef<HTMLElement>(null);

  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const controls = panel.current?.querySelectorAll<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled)');
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);

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
                placeholder="默认工作目录"
                onChange={event => onChange({ workDir: event.target.value })}
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
            <label htmlFor="ent-rs-model">模型</label>
            <select
              id="ent-rs-model"
              className="ent-rs-input"
              value={models.includes(settings.modelId) ? settings.modelId : conversation ? models[0] ?? '' : ''}
              disabled={!models.length}
              onChange={event => onChange({ modelId: event.target.value })}
            >
              {!models.length ? <option value="">{conversation ? '请先选择有可用模型的员工' : '没有所有员工共用的模型'}</option> : !conversation ? <option value="">使用各员工的可用默认模型</option> : null}
              {models.map(model => <option key={model} value={model}>{model}</option>)}
            </select>
            <small>只列出平台允许使用的模型，选择会随任务保存并用于实际执行。</small>
          </div>

          <div className="ent-rs-field">
            <span className="ent-rs-label">权限</span>
            <ul className="ent-rs-perms" role="radiogroup" aria-label="任务权限">
              {RUN_PERMISSIONS.map(item => (
                <li key={item.id}>
                  <label className="ent-rs-preset">
                    <input type="radio" name="task-permission" value={item.id}
                      checked={settings.permissions.preset === item.id}
                      onChange={() => onChange({ permissions: { ...settings.permissions, preset: item.id } })} />
                    <span><strong>{item.label}</strong><small>{item.hint}</small></span>
                  </label>
                </li>
              ))}
            </ul>
            <label className="ent-rs-risk">
              <input type="checkbox" checked={settings.permissions.approvalMode === 'auto-approve'}
                onChange={event => onChange({ permissions: { ...settings.permissions,
                  approvalMode: event.target.checked ? 'auto-approve' : 'confirm-each',
                } })} />
              忽略权限风险，不再逐次确认
            </label>
            <small>默认关闭。开启后，所选权限内的文件修改和命令执行将不再弹窗确认，可能造成文件丢失或系统变化；不会绕过员工授权、工具及路径限制。</small>
          </div>
        </div>
      </aside>
    </>
  );
}
