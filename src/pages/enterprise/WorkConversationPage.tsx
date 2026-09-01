/**
 * 对话式工作页。顶部先把「这项工作干到哪了」讲完，下面才是三列：进展 / 对话 / 背景。
 *
 * 用户打开这一页最想知道的是「到底做完了什么」，所以完成度、每一步的产出、
 * 已经拿到的结果都放在顶部概览和左列显眼位置，而不是压在页面底部。
 *
 * 「更换员工」是这里的关键动作：换人之后必须让用户清楚知道
 * 新员工能看到什么（工作目标、已确认资料、上一位员工的结果、你的补充说明），
 * 否则用户会担心要重新交代一遍。
 */

import { AlertTriangle, ArrowLeft, CheckCircle2, FileCheck2, Info, ListChecks, MessageSquare, RotateCcw, Send, StopCircle, UserCog, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Empty, EmployeeAvatar, StepStateChip, WorkStatusChip } from '../../components/enterprise/atoms';
import { completedStepCount, type EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { WorkItem, WorkStep } from '../../features/enterprise/types';
import { clockTime, relativeTime, stepProgressText } from '../../features/enterprise/vocabulary';

interface Props {
  workspace: EnterpriseWorkspace;
  workId: string;
}

export function WorkConversationPage({ workspace, workId }: Props) {
  const work = workspace.works.find(item => item.id === workId);
  const [draft, setDraft] = useState('');
  const [switchedTo, setSwitchedTo] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopReason, setStopReason] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [work?.messages.length, work?.updatedAt]);

  if (!work) {
    return (
      <div className="ent-page">
        <Empty title="找不到这项工作">它可能已经被删除。你可以在工作记录里查看其他工作。</Empty>
      </div>
    );
  }

  const done = completedStepCount(work.steps);
  const closed = work.status === 'completed' || work.status === 'failed';
  const activeStep = work.steps.find(step => step.state === 'running' || step.state === 'waiting-user');
  const people = [...new Set([work.currentEmployeeId, ...work.participants])].filter(Boolean);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    workspace.sendMessage(work.id, text);
    setDraft('');
  };

  const switchTo = (employeeId: string) => {
    const next = workspace.myEmployees.find(item => item.id === employeeId);
    if (!next || employeeId === work.currentEmployeeId) return;
    void workspace.switchEmployee(work.id, employeeId).then(() => setSwitchedTo(next.name));
  };

  const stop = () => {
    void workspace.stopWork(work.id, stopReason.trim() || '用户终止了这项工作');
    setStopping(false);
    setStopReason('');
  };

  return (
    <div className="ent-work">
      <button type="button" className="ent-back-link" onClick={() => workspace.navigate({ name: 'records' })}>
        <ArrowLeft size={13} aria-hidden />
        工作记录
      </button>

      <header className="ent-work-hero ent-card">
        <div className="ent-work-hero-top">
          <div className="ent-work-hero-id">
            <h1 className="ent-work-title">{work.title}</h1>
            <div className="ent-work-meta">
              <WorkStatusChip value={work.status} />
              <span className="ent-tag">开始于 {clockTime(work.createdAt)}</span>
              <span className="ent-tag">更新于 {relativeTime(work.updatedAt)}</span>
            </div>
          </div>
          <div className="ent-work-hero-actions">
            {work.status === 'failed' ? (
              <button type="button" className="ent-btn" onClick={() => void workspace.retryWork(work.id)} disabled={workspace.busy}>
                <RotateCcw size={14} aria-hidden />
                重新试一次
              </button>
            ) : null}
            {work.status === 'waiting-user' ? (
              <button type="button" className="ent-btn primary" onClick={() => void workspace.confirmStep(work.id)} disabled={workspace.busy}>
                <CheckCircle2 size={14} aria-hidden />
                确认，继续
              </button>
            ) : null}
            {!closed ? (
              <button type="button" className="ent-btn danger ghost" onClick={() => setStopping(true)} disabled={workspace.busy}>
                <StopCircle size={14} aria-hidden />
                终止当前工作
              </button>
            ) : null}
          </div>
        </div>

        <p className="ent-work-hero-goal"><span>目标</span>{work.goal}</p>

        <div className="ent-work-figures">
          <div className={`ent-work-figure${done && done === work.steps.length ? ' ready' : ''}`}>
            <span className="ent-work-figure-label"><ListChecks size={13} aria-hidden />已完成步骤</span>
            {/* 对话式工作没有拆步骤，写「0 / — 步」会像出错，直接说没拆。 */}
            {work.steps.length
              ? <strong>{done}<em>/ {work.steps.length} 步</em></strong>
              : <strong>—<em>没有拆步骤</em></strong>}
          </div>
          <div className={`ent-work-figure${work.deliverables.length ? ' brand' : ''}`}>
            <span className="ent-work-figure-label"><FileCheck2 size={13} aria-hidden />已拿到结果</span>
            <strong>{work.deliverables.length}<em>份</em></strong>
          </div>
          <div className="ent-work-figure">
            <span className="ent-work-figure-label"><Users size={13} aria-hidden />参与员工</span>
            <strong>{people.length}<em>位</em></strong>
          </div>
          <div className="ent-work-figure">
            <span className="ent-work-figure-label"><MessageSquare size={13} aria-hidden />对话往来</span>
            <strong>{work.messages.length}<em>条</em></strong>
          </div>
        </div>

        {work.steps.length ? (
          <div className="ent-progress" role="img" aria-label={stepProgressText(done, work.steps.length)}>
            <span style={{ width: `${Math.min(100, Math.max(2, work.progress))}%` }} />
          </div>
        ) : null}

        <p className={`ent-work-now ${nowTone(work)}`}>
          {work.status === 'waiting-user' || work.status === 'failed' ? <AlertTriangle size={14} aria-hidden /> : work.status === 'completed' ? <CheckCircle2 size={14} aria-hidden /> : <Info size={14} aria-hidden />}
          {nowLine(work, activeStep)}
        </p>

        {stopping ? (
          <div className="ent-confirm">
            <p><AlertTriangle size={14} aria-hidden /> 终止后员工会立刻停手，但<strong>已完成的动作和已产生的文件都会保留</strong>，你之后还能查看。</p>
            <label className="ent-field">
              <span>终止原因（会记录在工作记录里）</span>
              <input className="ent-input" value={stopReason} placeholder="例如：资料给错了，需要重新准备" onChange={event => setStopReason(event.target.value)} />
            </label>
            <div className="ent-confirm-foot">
              <button type="button" className="ent-btn ghost sm" onClick={() => setStopping(false)}>先不终止</button>
              <button type="button" className="ent-btn danger sm" onClick={stop}>确认终止</button>
            </div>
          </div>
        ) : null}
      </header>
      <aside className="ent-work-side ent-card pad">
        <h2 className="ent-work-side-title"><ListChecks size={14} aria-hidden />做了什么</h2>

        <h3>已经拿到的结果</h3>
        {work.deliverables.length ? (
          <ul className="ent-deliverables">
            {work.deliverables.map(item => (
              <li key={item.id}>
                <FileCheck2 size={14} aria-hidden />
                <span>
                  <strong>{item.name}</strong>
                  {item.note ? <small>{item.note}</small> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ent-hint">还没有可以交付的结果。员工产出文件或结论后会出现在这里。</p>
        )}

        {work.steps.length ? (
          <>
            <h3>每一步做到哪了</h3>
            <ul className="ent-work-steps">
              {work.steps.map((step, index) => (
                <li key={step.id} className={step.state}>
                  <span className="ent-work-step-no">{index + 1}</span>
                  <span>
                    <strong>{step.title}</strong>
                    <small>{step.employeeName}{step.output ? ` · 产出 ${step.output}` : ''}</small>
                  </span>
                  <StepStateChip value={step.state} />
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <h3>员工做过的动作</h3>
        {work.timeline.length ? (
          <ol className="ent-timeline">
            {work.timeline.map(entry => (
              <li key={entry.id} className={entry.kind}>
                <span className="ent-timeline-dot" aria-hidden />
                <span className="ent-timeline-body">
                  <strong>{entry.actor}</strong>
                  <span>{entry.text}</span>
                  <small>{clockTime(entry.at)}</small>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="ent-hint">还没有动作记录。员工开始做事后，每一步都会记在这里。</p>
        )}
      </aside>
      <section className="ent-work-main ent-card">
        <header className="ent-work-bar">
          <span className="ent-work-who">
            <EmployeeAvatar mark={workspace.myEmployees.find(item => item.id === work.currentEmployeeId)?.mark ?? '员'} size="sm" />
            <span>
              <small>当前正在与</small>
              <strong>{work.currentEmployeeName} 对话</strong>
            </span>
          </span>
          <label className="ent-work-switch">
            <UserCog size={14} aria-hidden />
            <span className="ent-visually-hidden">更换负责这项工作的员工</span>
            <select className="ent-select auto" value={work.currentEmployeeId} onChange={event => switchTo(event.target.value)} disabled={workspace.busy || closed}>
              {workspace.myEmployees.map(item => (
                <option key={item.id} value={item.id}>{item.id === work.currentEmployeeId ? `${item.name}（当前）` : `换成 ${item.name}`}</option>
              ))}
            </select>
          </label>
        </header>

        {switchedTo ? (
          <div className="ent-banner info ent-work-notice">
            <Info size={14} aria-hidden />
            <span>
              <strong>已经换成 {switchedTo}。</strong>
              它能直接看到工作目标、你已确认的资料、上一位员工的结果和你的补充说明，不需要你重新交代一遍。
            </span>
            <button type="button" className="link" onClick={() => setSwitchedTo(null)}>知道了</button>
          </div>
        ) : null}

        {work.nextUserAction ? (
          <div className="ent-banner attention ent-work-notice">
            <AlertTriangle size={14} aria-hidden />
            <span>需要你：{work.nextUserAction}</span>
            {work.status === 'waiting-user' ? (
              <button type="button" className="ent-btn sm primary" onClick={() => void workspace.confirmStep(work.id)} disabled={workspace.busy}>
                <CheckCircle2 size={13} aria-hidden />
                确认，继续
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="ent-chat">
          {work.messages.length ? work.messages.map(message => (
            <div key={message.id} className={`ent-msg ${message.role}`}>
              {message.role === 'employee' ? <EmployeeAvatar mark={message.employeeName?.slice(0, 1) ?? '员'} size="sm" /> : null}
              <div className="ent-msg-body">
                {message.role !== 'user' ? <small>{message.role === 'system' ? '系统记录' : message.employeeName}</small> : null}
                <p>{message.content}</p>
                <time>{clockTime(message.createdAt)}</time>
              </div>
            </div>
          )) : (
            <p className="ent-hint">还没有对话。写下你的要求，员工会接着做。</p>
          )}
          <div ref={endRef} />
        </div>

        <div className="ent-composer">
          <textarea
            className="ent-textarea"
            value={draft}
            placeholder={closed ? '这项工作已经结束，发送消息会让员工继续处理。' : `告诉 ${work.currentEmployeeName} 下一步要做什么（Ctrl + Enter 发送）`}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send(); }}
          />
          <button type="button" className="ent-btn primary" onClick={send} disabled={workspace.busy || !draft.trim()}>
            <Send size={14} aria-hidden />
            发送
          </button>
        </div>
      </section>
      <aside className="ent-work-side ent-card pad">
        <h2 className="ent-work-side-title"><Users size={14} aria-hidden />谁在做、知道什么</h2>
        <h3>参与这项工作的员工</h3>
        <ul className="ent-work-people">
          {people.map(id => {
            const person = workspace.myEmployees.find(item => item.id === id);
            const current = id === work.currentEmployeeId;
            return (
              <li key={id}>
                <EmployeeAvatar mark={person?.mark ?? '员'} size="sm" dim={!current} />
                <span>
                  <strong>{person?.name ?? '已停用的员工'}</strong>
                  <small>{current ? '正在负责' : '之前参与过'}</small>
                </span>
                {!current && person && !closed ? (
                  <button type="button" className="link" onClick={() => switchTo(person.id)} disabled={workspace.busy}>交给他</button>
                ) : null}
              </li>
            );
          })}
        </ul>

        <h3>已经同步给员工的背景</h3>
        <p className="ent-hint">换员工不会丢掉这些内容，新员工接手时能直接看到。</p>
        <ContextGroup label="工作目标" items={work.sharedContext.goal ? [work.sharedContext.goal] : []} empty="还没有写明目标" />
        <ContextGroup label="已确认资料" items={work.sharedContext.confirmedInputs} empty="你还没有提供资料" />
        <ContextGroup label="前一位员工的结果" items={work.sharedContext.previousResults} empty="暂时没有可交接的结果" />
        <ContextGroup label="你的补充说明" items={work.sharedContext.userNotes} empty="你还没有补充说明" />

        {work.workDir ? (
          <>
            <h3>工作文件夹</h3>
            <p className="ent-hint" title={work.workDir}>{work.workDir}</p>
          </>
        ) : null}
        {work.stopReason ? (
          <>
            <h3>终止原因</h3>
            <p className="ent-hint">{work.stopReason}</p>
          </>
        ) : null}
      </aside>
    </div>
  );
}

/** 共享背景的一组内容。空状态也要说清「为什么是空的」。 */
function ContextGroup({ label, items, empty }: { label: string; items: string[]; empty: string }) {
  return (
    <div className="ent-context">
      <strong>{label}</strong>
      {items.length ? (
        <ul>{items.map((item, index) => <li key={`${label}-${index}`}>{item}</li>)}</ul>
      ) : (
        <small>{empty}</small>
      )}
    </div>
  );
}

/**
 * 概览区最后那一句话：现在到底卡在哪、还是已经交付完了。
 * 状态和步骤都可能为空，所以每个分支都要给出能读懂的句子，不能落到空字符串。
 */
function nowLine(work: WorkItem, activeStep: WorkStep | undefined): string {
  if (work.status === 'completed') {
    return work.deliverables.length
      ? `这项工作已经做完，产出了 ${work.deliverables.map(item => item.name).join('、')}。`
      : '这项工作已经做完，结果都在下面的对话和动作记录里。';
  }
  if (work.status === 'failed') return `中途停下来了${work.nextUserAction ? `，需要你：${work.nextUserAction}` : '，可以重新试一次或换个员工'}。`;
  if (work.status === 'paused') return `你终止了这项工作${work.stopReason ? `：${work.stopReason}` : ''}。已经完成的部分都保留着。`;
  // nextUserAction 通常已经把步骤名写进去了，两个都拼会读到两遍步骤名，所以有步骤就只说步骤。
  if (work.status === 'waiting-user') {
    if (activeStep) return `等你确认「${activeStep.title}」这一步的结果，确认后才会继续往下做。`;
    return `等你确认${work.nextUserAction ? `：${work.nextUserAction}` : ''}，确认后才会继续往下做。`;
  }
  if (work.status === 'arranging') return '安排好了还没开始，你可以先补充资料，或者直接在对话里让员工动手。';
  return activeStep
    ? `${activeStep.employeeName} 正在做「${activeStep.title}」${activeStep.output ? `，准备产出${activeStep.output}` : ''}。`
    : `${work.currentEmployeeName} 正在处理，有进展会更新在这里。`;
}

/** 概览那句话的语气，和状态色保持一致。 */
function nowTone(work: WorkItem): string {
  switch (work.status) {
    case 'completed': return 'ready';
    case 'failed': return 'danger';
    case 'waiting-user': return 'attention';
    case 'paused':
    case 'arranging': return 'muted';
    default: return 'busy';
  }
}
