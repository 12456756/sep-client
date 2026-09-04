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
  /** 这些员工被允许使用的模型的并集。空数组表示企业没有开放选择。 */
  models: string[];
  onChange: (patch: Partial<RunSettings>) => void;
  onChooseFolder: () => Promise<string | null>;
  onClose: () => void;
}

export function RunSettingsDrawer({ settings, models, onChange, onChooseFolder, onClose }: Props) {
  const panel = useRef<HTMLElement>(null);

  // 抽屉是个临时层：Esc 关掉，打开时焦点进到面板里，否则键盘用户还留在页面上。
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    panel.current?.querySelector<HTMLElement>('input, select, button')?.focus();
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  const toggle = (id: RunPermissionId, enabled: boolean) => {
    onChange({ permissions: { ...settings.permissions, [id]: enabled } });
  };

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
              value={settings.model}
              disabled={!models.length}
              onChange={event => onChange({ model: event.target.value })}
            >
              <option value="">{models.length ? '由企业指定' : '企业未开放选择'}</option>
              {models.map(model => <option key={model} value={model}>{model}</option>)}
            </select>
            <small>这个选择只记在这台电脑上，模型下发通道打通后才会真的生效。</small>
          </div>

          <div className="ent-rs-field">
            <span className="ent-rs-label">权限</span>
            <ul className="ent-rs-perms">
              {RUN_PERMISSIONS.map(item => {
                const on = settings.permissions[item.id];
                return (
                  <li key={item.id}>
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.hint}</small>
                    </span>
                    <label className="ent-toggle">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={event => toggle(item.id, event.target.checked)}
                        aria-label={`${item.label}${on ? '已开启' : '已关闭'}`}
                      />
                      <i aria-hidden />
                      <em>{on ? 'ON' : 'OFF'}</em>
                    </label>
                  </li>
                );
              })}
            </ul>
            <small>关掉的项目员工碰不到。开着的项目在真正动手前仍然会单独问你一次。</small>
          </div>
        </div>
      </aside>
    </>
  );
}
