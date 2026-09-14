/**
 * 对话抽屉：一项工作里「你和员工说过的话」，以及说下一句的地方。
 *
 * 这就是原来钉在工作详情页最下面那个对话模块，整块搬进抽屉 —— 消息列表、
 * 输入框、换个人做、终止都还在里面，页面上其余的排版一格没动。
 *
 * 搬走的理由：一页工作报表的第一个问题永远是「干成了什么」，对话是你决定
 * 「接下来怎么办」时才要用的东西；而编排出来的工作根本没有对话可言
 * （员工的动作在「工作过程」里），页面底下常年空着一个对话框，
 * 反而让人以为每项工作都要在这里回话。
 *
 * 所以对话只在三个地方打开：对话式工作抬头的「继续对话」、编排工作停下来等你
 * 拍板或中断时的「补充说明」、已完成工作的「查看总结」。
 */

import { ChevronDown, Send, StopCircle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { WorkItem } from '../../features/enterprise/types';
import { useDrawer } from '../../features/enterprise/use-drawer';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import { EmployeeFace } from './EmployeeFace';

interface Props {
  work: WorkItem;
  workspace: EnterpriseWorkspace;
  onClose: () => void;
}

export function WorkTalkDrawer({ work, workspace, onClose }: Props) {
  const panel = useDrawer(onClose);
  const body = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState('');
  const [stopping, setStopping] = useState(false);
  const [reason, setReason] = useState('');
  const over = work.status === 'completed' || work.status === 'paused' || work.status === 'failed';

  // 只滚抽屉自己这一栏，不用 scrollIntoView —— 那会把底下的页面也一起拉下去。
  useEffect(() => {
    const node = body.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [work.messages.length]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    workspace.sendMessage(work.id, text);
    setDraft('');
  };

  return (
    <>
      <div className="ent-drawer-back" role="presentation" onMouseDown={onClose} />
      <aside className="ent-drawer wide" role="dialog" aria-modal="true" aria-labelledby="ent-talk-title" ref={panel}>
        <header className="ent-drawer-head">
          <EmployeeFace seed={work.currentEmployeeId || 'sep'} size="xl" />
          <div className="ent-drawer-id">
            <h2 id="ent-talk-title">和{work.currentEmployeeName}的对话</h2>
            <small title={work.title}>{work.title}</small>
          </div>
          <button type="button" className="ent-icon-btn" onClick={onClose} aria-label="关闭对话">
            <X size={15} aria-hidden />
          </button>
        </header>

        <div className="ent-drawer-body" ref={body}>
          <div className="ent-talk">
            {work.messages.map(message => (
              message.role === 'system' ? (
                <p className="ent-talk-sys" key={message.id}>{message.content}</p>
              ) : (
                <div className={`ent-say${message.role === 'user' ? ' user' : ''}`} key={message.id}>
                  {message.role === 'employee' ? (
                    <span className="ent-say-who">
                      <EmployeeFace seed={message.employeeId || work.currentEmployeeId} size="sm" round />
                      {message.employeeName}
                    </span>
                  ) : null}
                  <p>{message.content}</p>
                </div>
              )
            ))}
          </div>
        </div>

        <div className="ent-drawer-foot">
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
                  onClick={() => {
                    void workspace.stopWork(work.id, reason.trim() || '用户终止了这项工作');
                    setStopping(false);
                    setReason('');
                  }}
                >
                  确认终止
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
                {/* 换人只对对话式工作有意义：编排工作的每一步都各自写了由谁来做，
                    在这里换掉「当前员工」会和步骤上的安排对不上。 */}
                {work.kind === 'conversation' ? (
                  <label className="ent-ask-who">
                    <EmployeeFace seed={work.currentEmployeeId || 'sep'} size="sm" round />
                    <select
                      value={work.currentEmployeeId}
                      aria-label="换一位员工接手"
                      disabled={workspace.busy || over}
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
      </aside>
    </>
  );
}


