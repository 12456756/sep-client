/**
 * 对话式四步流程：选择员工 → 描述目标 → 执行设置 → 确认并开始。
 *
 * 普通用户只需要完成一条清晰主线；高级的自动编排和自己编排保留各自真实流程，
 * 不把复杂的工作图编辑器强行塞进普通用户的向导。
 */

import { ArrowLeft, ArrowRight, ChevronDown, Search, Settings2 } from 'lucide-react';
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

const STEPS = ['选择员工', '描述目标', '执行设置', '确认并开始'] as const;

type Step = 1 | 2 | 3 | 4;

export function ChatArrange({ employees, busy, employeeId, onEmployeeChange, onOpenSettings, onStart }: Props) {
  const [step, setStep] = useState<Step>(() => employeeId ? 2 : 1);
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

  const choose = (id: string) => {
    onEmployeeChange(id);
    setPickOpen(false);
    setQuery('');
    setStep(2);
  };

  const start = () => {
    if (ready && !busy) onStart(employeeId, text.trim());
  };

  return (
    <section className="ent-arr-chat">
      <ol className="ent-arr-steps" aria-label="对话式安排工作流程">
        {STEPS.map((label, index) => {
          const number = (index + 1) as Step;
          return (
            <li key={label} className={number === step ? 'active' : number < step ? 'done' : undefined}>
              <span>{number < step ? '✓' : `0${number}`}</span>{label}
            </li>
          );
        })}
      </ol>

      <header className="ent-arr-head ent-chat-head">
        <span className="ent-arr-kicker">对话式安排 · 第 {step} 步</span>
        <h1>{STEPS[step - 1]}</h1>
        <p>
          {step === 1 ? '先选择一位合适的硅基员工。' : null}
          {step === 2 ? '用自己的话描述想完成的事情，不需要提前写成复杂流程。' : null}
          {step === 3 ? '确认工作目录、模型和权限；不确定时保持默认即可。' : null}
          {step === 4 ? '检查工作内容，确认后才会真正开始执行。' : null}
        </p>
      </header>

      <div className="ent-chat-who" ref={pick}>
        <button
          type="button"
          className="ent-chat-whobtn"
          onClick={() => setPickOpen(open => !open)}
          aria-expanded={pickOpen}
          aria-haspopup="listbox"
        >
          <EmployeeFace employee={employee} name="选择一位同事" size="sm" round />
          <strong>{employee?.name ?? '选择一位同事'}</strong>
          <ChevronDown size={14} aria-hidden style={{ transform: pickOpen ? 'rotate(180deg)' : undefined }} />
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
                  </button>
                </li>
              ))}
              {found.length ? null : <li className="ent-chat-none">没有匹配的同事</li>}
            </ul>
          </div>
        ) : null}
      </div>

      {step === 1 ? (
        <div className="ent-chat-step-card">
          <EmployeeFace employee={employee} size="xl" round variant="portrait" />
          <strong>选择一位同事开始</strong>
          <p>可以先看看员工擅长什么，再决定把工作交给谁。</p>
        </div>
      ) : null}

      {step === 2 ? (
        <>
          <div className="ent-chat-room">
            {employee ? (
              <div className="ent-chat-open">
                <EmployeeFace employee={employee} size="xl" round variant="portrait" />
                <strong>{employee.name}</strong>
                <p>{employee.intro}</p>
                {employee.goodAt.length ? (
                  <div className="ent-chat-tips">
                    {employee.goodAt.slice(0, 4).map(item => (
                      <button key={item} type="button" onClick={() => { setText(current => (current.trim() ? current : `帮我${item}`)); input.current?.focus(); }}>
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
              aria-label="工作目标"
              onChange={event => setText(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && ready) setStep(3); }}
            />
          </div>
        </>
      ) : null}

      {step === 3 ? (
        <div className="ent-chat-step-card ent-chat-review-card">
          <Settings2 size={22} aria-hidden />
          <strong>执行设置</strong>
          <p>默认使用只读权限并逐次确认风险操作。你也可以打开设置调整工作目录、模型和权限。</p>
          <button type="button" className="ent-arr-ghost" onClick={onOpenSettings}><Settings2 size={14} aria-hidden />打开执行设置</button>
        </div>
      ) : null}

      {step === 4 ? (
        <div className="ent-chat-step-card ent-chat-confirm-card">
          <div className="ent-chat-confirm-person"><EmployeeFace employee={employee} size="md" round /><strong>{employee?.name}</strong></div>
          <div className="ent-chat-confirm-text"><span>工作目标</span><p>{text}</p></div>
          <small>确认后将创建工作并进入工作详情，你可以在那里继续对话和查看进展。</small>
        </div>
      ) : null}

      <div className="ent-chat-askbar">
        {step > 1 ? <button type="button" className="ent-arr-ghost" onClick={() => setStep((step - 1) as Step)}><ArrowLeft size={14} aria-hidden />上一步</button> : null}
        <span className="ent-arr-gap" />
        {step === 2 ? <small>Ctrl + Enter 下一步</small> : null}
        {step === 1 ? <button type="button" className="ent-arr-primary" disabled={!employee} onClick={() => setStep(2)}>下一步<ArrowRight size={15} aria-hidden /></button> : null}
        {step === 2 ? <button type="button" className="ent-arr-primary" disabled={!ready} onClick={() => setStep(3)}>下一步<ArrowRight size={15} aria-hidden /></button> : null}
        {step === 3 ? <button type="button" className="ent-arr-primary" onClick={() => setStep(4)}>确认设置并继续<ArrowRight size={15} aria-hidden /></button> : null}
        {step === 4 ? <button type="button" className="ent-arr-primary" onClick={start} disabled={!ready || busy}>{busy ? '正在安排…' : '确认并开始'}<ArrowRight size={15} aria-hidden /></button> : null}
      </div>
    </section>
  );
}
