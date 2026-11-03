import { ArrowRight, LoaderCircle, RotateCcw, X } from 'lucide-react'
import type { ScheduledCreation } from '../../../shared/scheduled-creation'
import type { ScheduledTasksModel } from '../../../features/enterprise/use-scheduled-tasks'

const LABELS: Record<ScheduledCreation['stage'], string> = {
  parsing: '正在理解任务', needs_input: '需要补充信息', blocked: '需要调整', planning: '正在生成工作计划',
  enabling: '正在启用', completed: '已创建并启用', failed: '创建未完成', cancelled: '已取消创建',
}

export function ScheduledCreationList({ model, onResume, onOpen }: {
  model: ScheduledTasksModel
  onResume(creation: ScheduledCreation): void
  onOpen(id: string): void
}) {
  const creations = [...(model.data?.creations ?? [])].sort((a, b) => b.createdAt - a.createdAt)
  const pending = model.pendingCreations ?? []
  if (!creations.length && !pending.length) return null
  return <section className="ent-sch-home-section ent-sch-creations" aria-label="定时任务创建进度">
    <h3>创建进度</h3>
    {pending.filter(item => !creations.some(creation => creation.id === item.request.requestId)).map(item => <article className="ent-sch-creation" key={item.request.requestId} aria-label="待确认的创建请求">
      <header><strong>{item.sending ? '正在提交任务' : '发送结果未确认'}</strong></header>
      <p className="ent-sch-creation-message">{item.request.message}</p>
      {item.error ? <p role="alert" className="ent-sch-modal-error">{item.error}</p> : null}
      {!item.sending ? <button type="button" className="ent-btn sm" onClick={() => void model.submitCreation(item.request)}><RotateCcw size={14} />重试同一请求</button> : null}
    </article>)}
    {creations.map(creation => {
      const uncertain = pending.find(item => item.request.requestId === creation.id)
      const working = ['parsing', 'planning', 'enabling'].includes(creation.stage)
      const terminal = creation.stage === 'completed' || creation.stage === 'cancelled'
      const cancelling = model.cancellingCreations?.includes(creation.id)
      return <article className="ent-sch-creation" key={creation.id} aria-label={`创建任务：${creation.interpretation?.task.title ?? creation.request.message}`}>
        <header><strong>{creation.interpretation?.task.title ?? '定时工作'}</strong><span className={`ent-sch-status ${creation.stage}`} role="status">{working ? <LoaderCircle className="ent-sch-spin" size={13} aria-hidden /> : null}{LABELS[creation.stage]}</span></header>
        <p className="ent-sch-creation-message">{creation.messages[0]?.content}</p>
        {working ? <ol className="ent-sch-creation-steps" aria-label="创建步骤">{['理解任务', '生成计划', '启用调度'].map((label, index) => <li key={label} aria-current={index === ['parsing', 'planning', 'enabling'].indexOf(creation.stage) ? 'step' : undefined}>{label}</li>)}</ol> : null}
        {creation.messages.length > 1 ? <details><summary>已补充的信息</summary>{creation.messages.slice(1).map((message, index) => <p key={index} className="ent-sch-creation-message">{message.content}</p>)}</details> : null}
        {creation.interpretation?.questions.length ? <ul className="ent-sch-creation-questions">{creation.interpretation.questions.map((question, index) => <li key={index}>{question.question}</li>)}</ul> : null}
        {creation.interpretation?.reasons.map(reason => <p key={reason.code} className="ent-sch-help">{reason.message}</p>)}
        {creation.error ? <p className="ent-sch-modal-error" role="alert">{creation.error}</p> : null}
        {uncertain?.error ? <p className="ent-sch-modal-error" role="alert">{uncertain.error}</p> : null}
        <footer className="ent-sch-actions">
          {creation.stage === 'completed' && creation.definitionId ? <button type="button" className="ent-btn sm" onClick={() => onOpen(creation.definitionId!)}>查看执行记录<ArrowRight size={14} /></button> : null}
          {!uncertain && (creation.stage === 'needs_input' || creation.stage === 'blocked') ? <button type="button" className="ent-btn sm" onClick={() => onResume(creation)}>继续填写<ArrowRight size={14} /></button> : null}
          {!terminal && (uncertain || creation.stage === 'failed') ? <button type="button" className="ent-btn sm" disabled={uncertain?.sending} onClick={() => void model.submitCreation(uncertain?.request ?? { ...creation.request, requestId: creation.id, expectedRevision: creation.revision })}><RotateCcw size={14} />重试同一请求</button> : null}
          {!terminal ? <button type="button" className="ent-btn ghost sm" disabled={cancelling} onClick={() => void model.cancelCreation(creation)}><X size={14} />{cancelling ? '正在取消…' : '取消创建'}</button> : null}
        </footer>
      </article>
    })}
  </section>
}
