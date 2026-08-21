import { AlertCircle, Bot, CircleStop, RotateCcw, UserRound, Wrench } from 'lucide-react';
import type { Task } from '../../features/workspace/useWorkspaceDemo';

interface Props {
  task: Task;
  onStop: () => void;
  onRetry: () => void;
  onModelChange: (modelId: string) => void;
  models: { id: string; displayName: string }[];
}

export function ConversationView({ task, onStop, onRetry, onModelChange, models }: Props) {
  const isRunning = task.status === 'queued' || task.status === 'running';
  const canRetry = task.status === 'failed' || task.status === 'stopped';

  return (
    <div className="conversation-view">
      <header className="conversation-header">
        <div>
          <small>对话任务 · {task.employeeName}</small>
          <h1>{task.title}</h1>
          <p className="task-context-line">
            工作空间：{task.workspace.displayName} · 技能：{task.skillIds.length || '未启用'}
          </p>
        </div>
        <div className="conversation-header-actions">
          <label className="model-inline-select">
            <span>模型</span>
            <select value={task.modelId} onChange={(event) => onModelChange(event.target.value)} disabled={isRunning}>
              {models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
            </select>
          </label>
          {isRunning ? <button className="workspace-secondary-button" onClick={onStop}><CircleStop size={16} />停止</button> : null}
          {canRetry ? <button className="workspace-secondary-button" onClick={onRetry}><RotateCcw size={16} />重试</button> : null}
        </div>
      </header>
      <div className="conversation-messages" aria-live="polite">
        {task.messages.map((message) => {
          const isUser = message.role === 'user';
          return (
            <article key={message.id} className={'conversation-message ' + message.role}>
              <span className="message-avatar" aria-hidden="true">{isUser ? <UserRound size={17} /> : <Bot size={17} />}</span>
              <div className="conversation-message-body">
                <div className="message-meta">{isUser ? '你' : message.modelId ? task.employeeName + ' · ' + message.modelId : task.employeeName}</div>
                <p className="message-bubble">{message.content || '正在生成…'}</p>
              </div>
            </article>
          );
        })}
        {task.activity ? <div className="conversation-activity"><Wrench size={15} /><span>{task.activity}</span><i /></div> : null}
        {task.status === 'failed' ? <div className="workspace-inline-error"><AlertCircle size={16} />本次生成失败，请重试。</div> : null}
        {task.status === 'stopped' ? <div className="workspace-inline-note">生成已停止，已有内容仍会保留。</div> : null}
      </div>
    </div>
  );
}
