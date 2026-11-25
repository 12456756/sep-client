import { useId } from 'react'
import { ArrowRight, LoaderCircle, RotateCcw, Trash2, X } from 'lucide-react'
import { isScheduledCreationFinished, isScheduledCreationWorking, type ScheduledCreation } from '../../../shared/scheduled-creation'
import type { ScheduledTasksModel } from '../../../features/enterprise/use-scheduled-tasks'
import { useFeedback } from '../../feedback/FeedbackProvider'

const LABELS: Record<ScheduledCreation['stage'], string> = {
  parsing: '正在理解任务', needs_input: '需要补充信息', blocked: '需要调整', planning: '正在生成工作计划',
  enabling: '正在启用', completed: '已创建并启用', failed: '创建未完成', cancelled: '已取消创建',
}

export function ScheduledCreationList({ model, onResume, onOpen }: {
  model: ScheduledTasksModel
  onResume(creation: ScheduledCreation): void
  onOpen(id: string): void
}) {
  const feedback = useFeedback()
  const deleteHintPrefix = useId()
  const creations = (model.data?.creations ?? []).filter(item => !item.deleted).sort((a, b) => b.createdAt - a.createdAt)
  const pending = model.pendingCreations ?? []
  const deleteRecord = (creation: ScheduledCreation) => feedback.confirm({
    key: `delete-scheduled-creation:${creation.id}`,
    message: '确认删除这条创建进度记录？已创建的定时任务和执行记录不受影响。',
    actionLabel: '删除',
    busyLabel: '正在删除…',
    onConfirm: async () => {
      const result = await model.deleteCreation(creation)
      return result?.success ? { success: true } : { success: false, message: result?.error?.message || '删除结果未确认，请刷新后重试。' }
    },
  })
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
      const working = isScheduledCreationWorking(creation.stage)
      const terminal = isScheduledCreationFinished(creation.stage)
      const cancelling = model.cancellingCreations?.includes(creation.id)
      const deleteHint = cancelling ? '正在取消创建，暂时无法删除。'
        : working ? '创建中暂不可删除，可等待完成或取消创建。'
          : uncertain?.sending ? '请求提交中，暂时无法删除。'
            : !terminal ? '创建尚未结束，暂不可删除。' : null
      const deleteHintId = deleteHint ? `${deleteHintPrefix}-${creation.id}` : undefined
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
          {!creation.fromConversation && !uncertain && (creation.stage === 'needs_input' || creation.stage === 'blocked') ? <button type="button" className="ent-btn sm" onClick={() => onResume(creation)}>继续填写<ArrowRight size={14} /></button> : null}
          {!creation.fromConversation && !terminal && (uncertain || creation.stage === 'failed') ? <button type="button" className="ent-btn sm" disabled={uncertain?.sending} onClick={() => void model.submitCreation(uncertain?.request ?? { ...creation.request, requestId: creation.id, expectedRevision: creation.revision })}><RotateCcw size={14} />重试同一请求</button> : null}
          {!terminal ? <button type="button" className="ent-btn ghost sm" disabled={cancelling} onClick={() => void model.cancelCreation(creation)}><X size={14} />{cancelling ? '正在取消…' : '取消创建'}</button> : null}
          <div className="ent-sch-creation-delete">
            <button type="button" className="ent-btn danger ghost sm" disabled={deleteHint !== null} aria-describedby={deleteHintId} onClick={() => void deleteRecord(creation)}><Trash2 size={14} aria-hidden />删除记录</button>
            {deleteHint && <span id={deleteHintId} className="ent-sch-help">{deleteHint}</span>}
          </div>
        </footer>
      </article>
    })}
  </section>
}
