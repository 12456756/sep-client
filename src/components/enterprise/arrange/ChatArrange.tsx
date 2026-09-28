/**
 * 会话模式：像传统桌面端聊天输入框一样，把员工选择和发送动作收进底部工具栏。
 * 页面主体保持安静，不用额外说明文字占据首屏。
 */

import { ArrowUp, ChevronDown, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SiliconEmployee } from '../../../features/enterprise/types';
import type { RunSettings } from '../../../features/enterprise/run-settings';
import { RunSettingsBar, RunSettingsDirectory } from './RunSettingsDrawer';
import { EmployeeFace } from '../EmployeeFace';

interface Props {
  employees: SiliconEmployee[];
  busy: boolean;
  employeeId: string;
  onEmployeeChange: (employeeId: string) => void;
  onStart: (employeeId: string, text: string) => void;
  settings: RunSettings;
  models: string[];
  onSettingsChange: (patch: Partial<RunSettings>) => void;
  onChooseFolder: () => Promise<string | null>;
}

export function ChatArrange({ employees, busy, employeeId, onEmployeeChange, onStart, settings, models, onSettingsChange, onChooseFolder }: Props) {
  const [pickOpen, setPickOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [text, setText] = useState('');
  const pick = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const employee = employees.find(item => item.id === employeeId);
  const ready = Boolean(employee && text.trim());
  const found = employees.filter(item => {
    const key = query.trim();
    return !key || item.name.includes(key) || item.intro.includes(key);
  });

  useEffect(() => {
    if (!pickOpen) return;
    const close = (event: MouseEvent) => {
      if (!pick.current?.contains(event.target as Node)) setPickOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setPickOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [pickOpen]);

  const choose = (id: string) => {
    onEmployeeChange(id);
    setPickOpen(false);
    setQuery('');
    input.current?.focus();
  };

  const start = () => {
    if (ready && !busy) onStart(employeeId, text.trim());
  };

  return (
    <section className="ent-arr-chat">
      <RunSettingsDirectory settings={settings} onChange={onSettingsChange} onChooseFolder={onChooseFolder} />
      <div className="ent-chat-ask">
        <textarea
          ref={input}
          className="ent-chat-input"
          value={text}
          placeholder="随心输入"
          aria-label="工作目标"
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && ready) {
              event.preventDefault();
              start();
            }
          }}
        />
        <div className="ent-chat-askbar">
          <div className="ent-chat-who" ref={pick}>
            <button
              type="button"
              className="ent-chat-whobtn"
              onClick={() => setPickOpen(open => !open)}
              aria-expanded={pickOpen}
              aria-haspopup="listbox"
            >
              <EmployeeFace employee={employee} name="选择同事" size="sm" round />
              <strong>{employee?.name ?? '选择同事'}</strong>
              <ChevronDown size={14} aria-hidden className={pickOpen ? 'up' : undefined} />
            </button>
            {pickOpen ? (
              <div className="ent-chat-pop" role="listbox" aria-label="选择员工">
                <div className="ent-chat-find">
                  <Search size={13} aria-hidden />
                  <input value={query} placeholder="搜索员工" aria-label="搜索员工" onChange={event => setQuery(event.target.value)} />
                </div>
                <ul>
                  {found.map(item => (
                    <li key={item.id}>
                      <button type="button" role="option" aria-selected={item.id === employeeId} className={item.id === employeeId ? 'on' : undefined} onClick={() => choose(item.id)}>
                        <EmployeeFace employee={item} size="sm" round />
                        <strong>{item.name}</strong>
                        <small>{item.roleName}</small>
                      </button>
                    </li>
                  ))}
                  {found.length ? null : <li className="ent-chat-none">没有匹配的同事</li>}
                </ul>
              </div>
            ) : null}
          </div>
          <RunSettingsBar
            settings={settings}
            models={models}
            conversation
            onChange={onSettingsChange}
          />
          <span className="ent-arr-gap" />
          <button type="button" className="ent-chat-send" aria-label="开始工作" disabled={!ready || busy} onClick={start}>
            <ArrowUp size={17} aria-hidden />
          </button>
        </div>
      </div>
    </section>
  );
}
