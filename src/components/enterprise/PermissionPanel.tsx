/**
 * 本机操作权限。由用户自己开启，开启时提醒影响范围。
 *
 * 界面上不出现工具名、协议或执行参数：用户只需要判断「我允不允许它这么做」。
 * 后端仍以 pi-extension/guard.ts 的策略为准，这里表达的是用户意愿。
 */

import { AlertTriangle, Check, FolderOpen, Info } from 'lucide-react';
import { useState } from 'react';
import type { OperationPermission, OperationPermissionId } from '../../features/enterprise/types';

interface Props {
  employeeName: string;
  permissions: OperationPermission[];
  disabled?: boolean;
  onToggle: (permissionId: OperationPermissionId, enabled: boolean) => void;
  onPickFolder: (permissionId: OperationPermissionId) => void;
}

const RISK_TEXT: Record<OperationPermission['risk'], string> = { low: '影响很小', medium: '需要留意', high: '权限较大' };

export function PermissionPanel({ employeeName, permissions, disabled = false, onToggle, onPickFolder }: Props) {
  /** 记录本次进入页面后刚被开启的项，用于展示一次醒目的提醒。 */
  const [justEnabled, setJustEnabled] = useState<OperationPermissionId[]>([]);

  const toggle = (permission: OperationPermission) => {
    const next = !permission.enabled;
    onToggle(permission.id, next);
    setJustEnabled(current => (next ? [...new Set([...current, permission.id])] : current.filter(id => id !== permission.id)));
  };

  return (
    <div className="ent-perm">
      <div className="ent-banner info">
        <Info size={14} aria-hidden />
        <span>
          <strong>这些权限只对你这台电脑生效</strong>
          {employeeName} 只能做你在下面开启的事。任何一项都可以随时关闭，关闭后立即生效。
        </span>
      </div>
      {permissions.map(permission => {
        const highlight = justEnabled.includes(permission.id);
        return (
          <div key={permission.id} className={`ent-perm-item${permission.enabled ? ' on' : ''}`}>
            <div className="ent-perm-head">
              <div className="ent-perm-copy">
                <strong>
                  {permission.label}
                  <span className={`ent-risk ${permission.risk}`}>{RISK_TEXT[permission.risk]}</span>
                </strong>
                <small>{permission.summary}</small>
              </div>
              <label className="ent-switch" title={permission.enabled ? '点击关闭' : '点击开启'}>
                <input
                  type="checkbox"
                  checked={permission.enabled}
                  disabled={disabled}
                  onChange={() => toggle(permission)}
                  aria-label={`${permission.enabled ? '关闭' : '开启'}${permission.label}`}
                />
                <span aria-hidden />
              </label>
            </div>
            {permission.enabled ? (
              <div className={`ent-perm-notice${highlight ? ' fresh' : ''}`}>
                {highlight ? <AlertTriangle size={13} aria-hidden /> : <Check size={13} aria-hidden />}
                <span>
                  {permission.notice}
                  {permission.confirmEachTime ? <em>每次动作前仍会单独问你一次。</em> : null}
                </span>
              </div>
            ) : null}
            {permission.enabled && permission.scope !== undefined ? (
              <div className="ent-perm-scope">
                <span title={permission.scope}>生效范围：{permission.scope || '未选择文件夹'}</span>
                <button type="button" className="ent-btn sm" onClick={() => onPickFolder(permission.id)} disabled={disabled}>
                  <FolderOpen size={13} aria-hidden />
                  选择文件夹
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}


