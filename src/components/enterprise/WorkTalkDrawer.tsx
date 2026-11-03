import { ArrowDown, ChevronDown, Send, StopCircle, X } from 'lucide-react';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SetStateAction } from 'react';
import { isSubmitEnter } from '../../shared/composer-shortcut';
import type { WorkItem } from '../../features/enterprise/types';
import { useDrawer } from '../../features/enterprise/use-drawer';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import { EmployeeFace } from './EmployeeFace';
import '../../styles/conversation.css';
import { useSpeechInput } from '../../features/speech/use-speech-input';
import { SpeechInputActions } from '../speech/SpeechInputActions';
import { AttachmentComposer } from './attachments/AttachmentComposer';
import type { AttachmentImportSession, AttachmentView } from '../../shared/attachment-contracts';
import { ConversationSessionsContext, createConversationSessions } from '../../features/enterprise/conversation-sessions';
import { GENERAL_ASSISTANT_ID } from '../../features/enterprise/general-assistant';
import { KnowledgeSelector } from './KnowledgeSelector';
import { noKnowledgeSelection } from '../../shared/knowledge-selection';
import { ConversationMedia } from '../../features/enterprise/conversation-media';
import { useConversationQueue } from '../../features/enterprise/use-conversation-queue';
import { ConversationMessages } from './ConversationMessages';

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
        <WorkConversation key={`${workspace.attachmentScopeKey}:${work.id}`} work={work} workspace={workspace} onClose={onClose} />
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
  const queued = useConversationQueue(work.id, workspace.attachmentScopeKey);
  const inheritedSessions = useContext(ConversationSessionsContext);
  const [localSessions] = useState(() => createConversationSessions(sessionId => { void window.electronAPI.cancelAttachmentImport({ sessionId }).catch(() => undefined); }));
  const sessions = inheritedSessions ?? localSessions;
  const [savedSession] = useState(() => sessions.get(work.id));
  const retainedAttachments = savedSession.attachment;
  useLayoutEffect(() => { sessions.retain(work.id, savedSession); }, [sessions, work.id, savedSession]);
  useEffect(() => { if (!inheritedSessions) return localSessions.retainOwner(); }, [inheritedSessions, localSessions]);
  const body = useRef<HTMLDivElement | null>(null);
  useSyncExternalStore(savedSession.subscribe, () => savedSession.revision, () => savedSession.revision);
  const sending = savedSession.sending;
  const draft = savedSession.draft;
  const setDraft = useCallback((update: SetStateAction<string>) => {
    savedSession.setDraft(typeof update === 'function' ? update(savedSession.draft) : update);
  }, [savedSession]);
  const [attachments, setAttachments] = useState<AttachmentView[]>(retainedAttachments.attachments);
  const [attachmentSession, setAttachmentSession] = useState<AttachmentImportSession | null>(retainedAttachments.session);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const knowledge = savedSession.knowledge ?? work.knowledge ?? noKnowledgeSelection();
  const setKnowledge = savedSession.setKnowledge;
  useEffect(() => {
    let active = true;
    if (savedSession.knowledge === undefined) {
      void window.electronAPI.listTaskRuns(work.id).then(result => {
        if (!active || savedSession.knowledge !== undefined || !result.success) return;
        const latest = [...(result.runs ?? [])].sort((a, b) => b.startedAt - a.startedAt)[0];
        const restored = latest?.knowledge ?? work.knowledge ?? noKnowledgeSelection();
        savedSession.setKnowledge(restored.mode === 'manual' ? { ...restored, sources: [] } : restored);
      }).catch(() => undefined);
    }
    return () => { active = false; };
  }, [savedSession, work.id, work.knowledge]);
  const [attachmentListContainer, setAttachmentListContainer] = useState<HTMLDivElement | null>(null);
  const composerId = useMemo(() => `conversation-${work.id}`, [work.id]);
  const [editorVersion, setEditorVersion] = useState(0);
  const onPasteEdit = useCallback(({ text: pasted, selectionStart, selectionEnd, editorVersion: pastedVersion }: { text: string; selectionStart: number; selectionEnd: number; editorVersion: number }) => {
    if (pastedVersion !== editorVersion) return false;
    setDraft(current => `${current.slice(0, selectionStart)}${pasted}${current.slice(selectionEnd)}`);
    setEditorVersion(version => version + 1);
    return true;
  }, [editorVersion, setDraft]);
  const speech = useSpeechInput({ contextKey: `work:${work.id}`, value: draft, onChange: setDraft, disabled: workspace.busy });
  const over = work.status === 'completed' || work.status === 'paused' || work.status === 'failed';

  const followsLatest = useRef(savedSession.followsLatest);
  const [hasNewContent, setHasNewContent] = useState(false);
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = savedSession.scrollTop;
  }, [savedSession]);
  const latestMessage = work.messages.at(-1);
  const latestMessageId = latestMessage?.id;
  const latestContent = latestMessage?.content;
  const preparing = (queued.queue.preparing === true || queued.queue.preparing === undefined && !work.lastRunId) && work.status === 'arranging' && !work.isActive;
  const unstarted = queued.queue.preparing === false && work.status === 'arranging' && !work.isActive && !work.lastRunId;
  const isReplying = work.isActive === true || preparing;
  const hasStreamingReply = work.messages.some(message => message.id === `${work.id}-streaming`);
  const statusText = work.status === 'completed' ? '本轮回复已完成，可继续提问'
    : work.status === 'paused' ? '工作已终止，已收到的内容仍保留'
      : work.status === 'failed' ? '本轮回复中断，请查看提示后重试'
        : work.status === 'waiting-user' ? '等待你的确认'
          : preparing ? '正在准备执行，请稍候…'
          : work.status === 'arranging' && !isReplying ? '尚未开始'
            : work.status === 'arranging' ? '正在排队，请稍候'
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

  const send = async () => {
    const text = draft.trim();
    if (!text || workspace.busy || speech.busy || attachmentsBusy || savedSession.sending) return;
    const fingerprint = JSON.stringify([text, attachmentSession?.sessionId, attachments.map(item => item.attachmentId), knowledge]);
    const messageId = savedSession.beginSend(fingerprint);
    if (!messageId) return;
    followsLatest.current = true;
    setHasNewContent(false);
    try {
      const sent = await workspace.sendMessage(work.id, text, attachments, attachmentSession?.sessionId, knowledge, messageId);
      if (!sent) return;
      savedSession.acceptSend(draft);
      setAttachments([]);
      setAttachmentSession(null);
      void queued.refresh();
    } finally { savedSession.finishSend(); }
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
          savedSession.scrollTop = node.scrollTop;
          savedSession.followsLatest = followsLatest.current;
          if (followsLatest.current) setHasNewContent(false);
        }}>
          <div className="ent-talk">
            <ConversationMessages work={work} employees={workspace.employees} scopeKey={workspace.attachmentScopeKey} preparing={preparing} />
            <ConversationMedia taskId={work.id} visible />
          </div>
        </div>

        <div className="ent-drawer-foot ent-conversation-foot">
          {queued.queue.items.length > 0 || queued.queue.failed ? <details className="ent-conversation-queue">
            <summary>等待处理 {queued.queue.items.length}/10{queued.queue.paused ? ' · 已暂停' : ''}</summary>
            {queued.queue.failed ? <p>未完成：{queued.queue.failed.prompt}</p> : null}
            <ol>{queued.queue.items.map(item => <li key={item.id}>{item.prompt}{item.attachmentNames.length ? <small>附件：{item.attachmentNames.join('、')}</small> : null}</li>)}</ol>
            {queued.queue.failed?.recoveryConfirmationRequired ? <p>会话文件已损坏，需要确认后根据任务历史重建上下文。</p> : null}
            {queued.queue.paused ? <button type="button" className="ent-btn sm" disabled={queued.busy || work.isActive} onClick={() => void (queued.queue.failed?.recoveryConfirmationRequired ? queued.recover() : queued.resume())}>{queued.queue.failed?.recoveryConfirmationRequired ? '重建会话并继续' : queued.queue.failed || work.status === 'failed' ? '重试并继续' : '继续处理'}</button> : null}
            {over ? <button type="button" className="ent-btn sm ghost" disabled={workspace.busy} onClick={() => void workspace.stopWork(work.id, '用户终止了这项工作')}>终止</button> : null}
          </details> : null}
          {hasNewContent ? <button type="button" className="ent-btn sm ent-new-content" onClick={scrollToLatest}>
            <ArrowDown size={14} aria-hidden />有新内容，回到最新
          </button> : null}
          <p className="ent-conversation-status" role="status">
            {isReplying ? <span className="ent-reply-dot" aria-hidden /> : null}{statusText}
          </p>
          {unstarted ? <button type="button" className="ent-btn sm" disabled={queued.busy || workspace.busy} onClick={() => void queued.resume()}>开始执行</button> : null}
          <div className="ent-ask">
          <div className="ent-composer-attachments" ref={setAttachmentListContainer} />
          <textarea
            data-composer-id={composerId}
            data-editor-version={editorVersion}
                {...speech.inputProps}
                className="ent-ask-input"
                value={draft}
                placeholder={queued.queue.paused ? '可继续添加信息，点击继续处理后依次执行' : isReplying ? '补充信息将排队依次处理' : `告诉 ${work.currentEmployeeName} 下一步要做什么`}
                aria-label="给员工的下一句话"
                onChange={event => { setDraft(event.target.value); setEditorVersion(version => version + 1); }}
                onKeyDown={event => { speech.inputProps.onKeyDown(event); if (isSubmitEnter(event, speech.isComposing())) { event.preventDefault(); send(); } }}
              />
              <div className="ent-ask-bar">
                <AttachmentComposer key={savedSession.attachmentEpoch} listContainer={attachmentListContainer} target={{ kind: 'compose', composerId }} bindingKey={`${workspace.attachmentScopeKey}:${work.id}`} retainedState={retainedAttachments} disabled={workspace.busy || sending} onChange={setAttachments} onSessionChange={setAttachmentSession} onBusyChange={setAttachmentsBusy} onPasteEdit={onPasteEdit} />
                {/* 换人只对对话式工作有意义：流程工作的每一步都各自写了由谁来做，
                    在这里换掉「当前员工」会和步骤上的安排对不上。 */}
                {work.currentEmployeeId === GENERAL_ASSISTANT_ID ? (
                  <span className="ent-ask-who"><EmployeeFace name="通用助手" size="sm" round /><strong>通用助手</strong></span>
                ) : work.kind === 'conversation' ? (
                  <label className="ent-ask-who">
                    <EmployeeFace employee={workspace.employees.find(item => item.id === work.currentEmployeeId)} name={work.currentEmployeeName} size="sm" round />
                    <select
                      value={work.currentEmployeeId}
                      aria-label="换一位员工接手"
                      disabled={workspace.busy || sending || isReplying || queued.queue.items.length > 0 || !!queued.queue.failed}
                      onChange={event => void workspace.switchEmployee(work.id, event.target.value)}
                    >
                      {workspace.myEmployees.map(item => (
                        <option key={item.id} value={item.id}>{item.name}{item.id === work.currentEmployeeId ? '（当前）' : ''}</option>
                      ))}
                    </select>
                    <ChevronDown size={13} aria-hidden />
                  </label>
                ) : null}
                <KnowledgeSelector value={knowledge} onChange={setKnowledge} disabled={workspace.busy || sending} scopeKey={workspace.attachmentScopeKey} />
                <span className="ent-ask-spacer" />
                {over ? null : (
                  <button type="button" className="ent-ask-stop" disabled={workspace.busy} onClick={() => { void workspace.stopWork(work.id, '用户终止了这项工作'); }}>
                    <StopCircle size={13} aria-hidden />
                    终止
                  </button>
                )}
                <SpeechInputActions speech={speech} disabled={workspace.busy} />
                <button type="button" className="ent-ask-send" onClick={send} disabled={!draft.trim() || workspace.busy || sending || speech.busy || attachmentsBusy} aria-label="发送">
                  <Send size={15} aria-hidden />
                </button>
              </div>
          </div>
        </div>
    </>
  );
}
