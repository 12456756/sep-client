import { ArrowDown, ChevronDown, Send, StopCircle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { WorkItem } from '../../features/enterprise/types';
import { useDrawer } from '../../features/enterprise/use-drawer';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import { EmployeeFace } from './EmployeeFace';
import { MessageContent } from './MessageContent';
import '../../styles/conversation.css';

const FOLLOW_THRESHOLD_PX = 48;

interface Props {
  work: WorkItem;
  workspace: EnterpriseWorkspace;
  onClose: () => void;
}

/** 流程工作仍使用抽屉；对话式直接复用同一消息区，不开启模态焦点锁。 */
export function WorkTalkDrawer({ work, workspace, onClose }: Props) {
  const panel = useDrawer(onClose);
  return (
    <>
      <div className="ent-drawer-back" role="presentation" onMouseDown={onClose} />
      <aside className="ent-drawer wide" role="dialog" aria-modal="true" aria-labelledby="ent-talk-title" ref={panel}>
        <WorkConversation work={work} workspace={workspace} onClose={onClose} />
      </aside>
    </>
  );
}

interface ConversationProps {
  work: WorkItem;
  workspace: EnterpriseWorkspace;
  onClose?: () => void;
}

export function WorkConversation({ work, workspace, onClose }: ConversationProps) {
  const body = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState('');
  const [stopping, setStopping] = useState(false);
  const [reason, setReason] = useState('');
  const over = work.status === 'completed' || work.status === 'paused' || work.status === 'failed';

  const followsLatest = useRef(true);
  const [hasNewContent, setHasNewContent] = useState(false);
  const latestMessage = work.messages.at(-1);
  const latestMessageId = latestMessage?.id;
  const latestContent = latestMessage?.content;
  const isReplying = work.status === 'running' || work.status === 'arranging';
  const hasStreamingReply = work.messages.some(message => message.id === `${work.id}-streaming`);
  const statusText = work.status === 'completed' ? '本轮回复已完成，可继续提问'
    : work.status === 'paused' ? '工作已终止，已收到的内容仍保留'
      : work.status === 'failed' ? '本轮回复中断，请查看提示后重试'
        : work.status === 'waiting-user' ? '等待你的确认'
          : hasStreamingReply ? '正在回复…' : '正在处理，请稍候…';

  const scrollToLatest = () => {
    followsLatest.current = true;
    setHasNewContent(false);
    const node = body.current;
    if (node) node.scrollTop = node.scrollHeight;
  };

  // 只在消息实际改变时跟随；向上阅读时不因后续 token 抢走滚动位置。
  useEffect(() => {
    const node = body.current;
    if (!node) return;
    if (followsLatest.current) node.scrollTop = node.scrollHeight;
    else setHasNewContent(true);
  }, [latestMessageId, latestContent]);

  const send = () => {
    const text = draft.trim();
    if (!text || workspace.busy) return;
    followsLatest.current = true;
    setHasNewContent(false);
    void workspace.sendMessage(work.id, text);
    setDraft('');
  };

  return (
    <>
        <header className="ent-drawer-head">
          <EmployeeFace employee={workspace.employees.find(item => item.id === work.currentEmployeeId)} name={work.currentEmployeeName} size={onClose ? "xl" : "sm"} variant="portrait" />
          <div className="ent-drawer-id">
            <h2 id="ent-talk-title">和{work.currentEmployeeName}的对话</h2>
            {onClose ? <small title={work.title}>{work.title}</small> : null}
          </div>
          {onClose ? <button type="button" className="ent-icon-btn" onClick={onClose} aria-label="关闭对话">
            <X size={15} aria-hidden />
          </button> : null}
        </header>

        <div className="ent-drawer-body ent-conversation-body" ref={body} onScroll={() => {
          const node = body.current;
          if (!node) return;
          followsLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_THRESHOLD_PX;
          if (followsLatest.current) setHasNewContent(false);
        }}>
          <div className="ent-talk">
            {work.messages.map(message => (
              message.role === 'system' ? (
                <p className="ent-talk-sys" key={message.id}>{message.content}</p>
              ) : (
                <div className={`ent-say${message.role === 'user' ? ' user' : ''}`} key={message.id}>
                  {message.role === 'employee' ? (
                    <span className="ent-say-who">
                      <EmployeeFace employee={workspace.employees.find(item => item.id === (message.employeeId || work.currentEmployeeId))} name={message.employeeName} size="sm" round />
                      {message.employeeName}
                    </span>
                  ) : null}
                  {message.role === 'user' ? <p>{message.content}</p> : <MessageContent content={message.content} />}
                  <time className="ent-message-time" dateTime={new Date(message.createdAt).toISOString()}>
                    {new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </time>
                </div>
              )
            ))}
          </div>
        </div>

        <div className="ent-drawer-foot ent-conversation-foot">
          {hasNewContent ? <button type="button" className="ent-btn sm ent-new-content" onClick={scrollToLatest}>
            <ArrowDown size={14} aria-hidden />有新内容，回到最新
          </button> : null}
          <p className="ent-conversation-status" role="status">
            {isReplying ? <span className="ent-reply-dot" aria-hidden /> : null}{statusText}
          </p>
          {workspace.error ? <p role="alert" className="ent-hint">{workspace.error}</p> : null}
          {stopping ? (
            <div className="ent-confirm">
              <p>
                <StopCircle size={14} aria-hidden />
                终止之后这项工作不再继续，<strong>已完成的部分和已产出的文件会保留</strong>。
              </p>
              <input className="ent-input" value={reason} placeholder="终止原因（可留空）" onChange={event => setReason(event.target.value)} />
              <div className="ent-confirm-foot">
                <button type="button" className="ent-btn sm" onClick={() => setStopping(false)}>不终止</button>
                <button
                  type="button"
                  className="ent-btn danger sm"
                  disabled={workspace.busy}
                  onClick={() => {
                    void workspace.stopWork(work.id, reason.trim() || '用户终止了这项工作').then(ok => {
                      if (ok) { setStopping(false); setReason(''); }
                    });
                  }}
                >
                  {workspace.busy ? '正在终止…' : '确认终止'}
                </button>
              </div>
            </div>
          ) : (
            <div className="ent-ask">
              <textarea
                className="ent-ask-input"
                value={draft}
                placeholder={over ? '这项工作已经结束，说一句会重新开始跟进' : `告诉 ${work.currentEmployeeName} 下一步要做什么（Ctrl + Enter 发送）`}
                aria-label="给员工的下一句话"
                onChange={event => setDraft(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); } }}
              />
              <div className="ent-ask-bar">
                {/* 换人只对对话式工作有意义：流程工作的每一步都各自写了由谁来做，
                    在这里换掉「当前员工」会和步骤上的安排对不上。 */}
                {work.kind === 'conversation' ? (
                  <label className="ent-ask-who">
                    <EmployeeFace employee={workspace.employees.find(item => item.id === work.currentEmployeeId)} name={work.currentEmployeeName} size="sm" round />
                    <select
                      value={work.currentEmployeeId}
                      aria-label="换一位员工接手"
                      disabled={workspace.busy || work.status === 'running' || work.status === 'waiting-user'}
                      onChange={event => void workspace.switchEmployee(work.id, event.target.value)}
                    >
                      {workspace.myEmployees.map(item => (
                        <option key={item.id} value={item.id}>{item.name}{item.id === work.currentEmployeeId ? '（当前）' : ''}</option>
                      ))}
                    </select>
                    <ChevronDown size={13} aria-hidden />
                  </label>
                ) : null}
                <span className="ent-ask-spacer" />
                {over ? null : (
                  <button type="button" className="ent-ask-stop" onClick={() => setStopping(true)}>
                    <StopCircle size={13} aria-hidden />
                    终止
                  </button>
                )}
                <button type="button" className="ent-ask-send" onClick={send} disabled={!draft.trim() || workspace.busy} aria-label="发送">
                  <Send size={15} aria-hidden />
                </button>
              </div>
            </div>
          )}
        </div>
    </>
  );
}
