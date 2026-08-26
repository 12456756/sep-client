import { AlertCircle, Bot, CircleStop, RotateCcw, UserRound, Wrench } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AvailableEmployee, Task } from '../../features/workspace/useWorkspaceDemo';

interface Props {
  task: Task;
  employees: AvailableEmployee[];
  activeEmployeeId: string;
  onStop: () => void;
  onRetry: () => void;
}

export function ConversationView({ task, employees, activeEmployeeId, onStop, onRetry }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [followLatest, setFollowLatest] = useState(true);
  const [showLatest, setShowLatest] = useState(false);
  const employee = employees.find(item => item.id === activeEmployeeId) || employees.find(item => item.id === task.employeeId);
  const running = task.status === 'queued' || task.status === 'running';
  const canRetry = task.status === 'failed' || task.status === 'stopped';

  const scrollToLatest = (behavior: ScrollBehavior = 'auto') => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    setFollowLatest(true);
    setShowLatest(false);
  };

  useLayoutEffect(() => { scrollToLatest(); }, [task.id]);
  const latestMessageLength = task.messages[task.messages.length - 1]?.content.length ?? 0;
  useEffect(() => { if (followLatest) scrollToLatest('smooth'); }, [latestMessageLength, task.activity, followLatest]);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => {
      const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
      setFollowLatest(nearBottom);
      setShowLatest(!nearBottom && running);
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [running]);

  return <section className="conversation-panel">
    <header className="conversation-participant-bar"><div className="participant-current"><span className="message-avatar employee-avatar">{employee?.avatar || <Bot size={17} />}</span><div><small>当前负责员工</small><strong>{employee?.displayName || task.employeeName}</strong></div><span className={`participant-status ${running ? 'working' : task.status === 'failed' ? 'failed' : 'ready'}`} aria-label={running ? '正在工作' : task.status === 'failed' ? '工作失败' : '工作已完成'} title={running ? '正在工作' : task.status === 'failed' ? '工作失败' : '工作已完成'} /> </div><span className="participant-context-hint">对话上下文已共享</span></header>
    <div className="conversation-context-line">已加入当前对话：{employees.filter(item => item.id === task.employeeId || item.id === activeEmployeeId).map(item => item.displayName).join(' · ') || task.employeeName}</div>
    <div className="conversation-messages" ref={scrollRef} aria-live="polite">
      <div className="conversation-message-list">{task.messages.map(message => { const isUser = message.role === 'user'; return <article key={message.id} className={`conversation-message ${message.role}`}><span className="message-avatar">{isUser ? <UserRound size={17} /> : employee?.avatar || <Bot size={17} />}</span><div className="conversation-message-body"><div className="message-meta">{isUser ? '我' : `${message.modelId ? `${employee?.displayName || task.employeeName} · ${message.modelId}` : employee?.displayName || task.employeeName}`}</div><p className="message-bubble">{message.content || '正在生成…'}</p></div></article>; })}{task.activity && <div className="conversation-activity"><Wrench size={15} /><span>{task.activity}</span><i /></div>}{task.status === 'failed' && <div className="workspace-inline-error"><AlertCircle size={16} />本次工作没有完成，请稍后重试。</div>}{task.status === 'stopped' && <div className="workspace-inline-note">工作已暂停，已有内容仍会保留。</div>}</div>
      {showLatest && <button className="scroll-latest-button" onClick={() => scrollToLatest('smooth')} title="回到最新消息">回到底部</button>}
    </div>
    <div className="conversation-panel-actions">{running && <button className="workspace-secondary-button" onClick={onStop} title="暂停当前工作"><CircleStop size={16} />暂停工作</button>}{canRetry && <button className="workspace-secondary-button" onClick={onRetry} title="重新安排当前工作"><RotateCcw size={16} />重新安排</button>}</div>
  </section>;
}
