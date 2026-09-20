/**
 * 对话式。整屏只有一件事：和一位同事说话。
 *
 * 顶上那个员工选择器是个 Popover，换人立刻替换头像和名字，不跳页 ——
 * 「换个人说」和「说下一句」在用户心里是同一层动作，不该打断当前这一屏。
 *
 * 开始之前这里没有对话记录，所以中间放的是这位同事是谁、擅长什么：
 * 点一条擅长的事就把它填进输入框，用户不用从零开始想第一句话。
 * 真正的对话在工作详情页继续（见 WorkDetailPage）。
 */

import { ArrowRight, ChevronDown, Search, Settings2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SiliconEmployee } from '../../../features/enterprise/types';
import { EmployeeFace } from '../EmployeeFace';

interface Props {
  employees: SiliconEmployee[];
  busy: boolean;
  employeeId: string;
  onEmployeeChange: (employeeId: string) => void;
  onOpenSettings: () => void;
  onStart: (employeeId: string, text: string) => void;
}

export function ChatArrange({ employees, busy, employeeId, onEmployeeChange, onOpenSettings, onStart }: Props) {
  const [pickOpen, setPickOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [text, setText] = useState('');
  const pick = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

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

  const employee = employees.find(item => item.id === employeeId);
  const ready = Boolean(employee && text.trim());
  const found = employees.filter(item => {
    const key = query.trim();
    if (!key) return true;
    return item.name.includes(key) || item.intro.includes(key);
  });

  const send = () => { if (ready && !busy) onStart(employeeId, text); };

  const choose = (id: string) => {
    onEmployeeChange(id);
    setPickOpen(false);
    setQuery('');
  };

  return (
    <section className="ent-arr-chat">

      <div className="ent-chat-who" ref={pick}>
        <button
          type="button"
          className="ent-chat-whobtn"
          onClick={() => setPickOpen(open => !open)}
          aria-expanded={pickOpen}
          aria-haspopup="listbox"
        >
          <EmployeeFace seed={employeeId || 'sep'} size="sm" round />
          <strong>{employee?.name ?? '选择一位同事'}</strong>
          <ChevronDown size={14} aria-hidden style={{ transform: pickOpen ? 'rotate(180deg)' : undefined }} />
        </button>
        {pickOpen ? (
          <div className="ent-chat-pop" role="listbox" aria-label="选择员工">
            <div className="ent-chat-find">
              <Search size={13} aria-hidden />
              <input
                value={query}
                placeholder="搜索员工"
                aria-label="搜索员工"
                onChange={event => setQuery(event.target.value)}
              />
            </div>
            <ul>
              {found.map(item => (
                <li key={item.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={item.id === employeeId}
                    className={item.id === employeeId ? 'on' : undefined}
                    onClick={() => choose(item.id)}
                  >
                    <EmployeeFace seed={item.id} size="sm" round />
                    <strong>{item.name}</strong>
                  </button>
                </li>
              ))}
              {found.length ? null : <li className="ent-chat-none">没有匹配的同事</li>}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="ent-chat-room">
        {employee ? (
          <div className="ent-chat-open">
            <EmployeeFace seed={employee.id} size="xl" round />
            <strong>{employee.name}</strong>
            <p>{employee.intro}</p>
            {employee.goodAt.length ? (
              <div className="ent-chat-tips">
                {employee.goodAt.slice(0, 4).map(item => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => { setText(current => (current.trim() ? current : `帮我${item}`)); input.current?.focus(); }}
                  >
                    {item}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="ent-chat-ask">
        <textarea
          ref={input}
          className="ent-chat-input"
          value={text}
          placeholder={employee ? `把要做的事直接说给${employee.name}，例如：帮我把上个月的客户往来整理成一份周报` : '先选一位同事'}
          aria-label="第一句话"
          onChange={event => setText(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send(); }}
        />
        <div className="ent-chat-askbar">
          <button type="button" className="ent-arr-ghost" onClick={onOpenSettings}>
            <Settings2 size={14} aria-hidden />
            执行设置
          </button>
          <span className="ent-arr-gap" />
          <small>Ctrl + Enter 直接开始</small>
          <button type="button" className="ent-arr-primary" onClick={send} disabled={!ready || busy}>
            {busy ? '正在安排…' : '开始对话'}
            <ArrowRight size={15} aria-hidden />
          </button>
        </div>
      </div>
    </section>
  );
}
