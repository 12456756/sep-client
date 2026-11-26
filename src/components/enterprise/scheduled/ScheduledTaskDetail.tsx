import { useEffect, useRef, useState } from 'react'
import { FileText, Pencil, Trash2 } from 'lucide-react'
import type { ScheduledWorkPlan, ScheduledDefinition, ScheduledOccurrence } from '../../../shared/scheduled-tasks'
import { retiredScheduledExecutionMessage } from '../../../shared/scheduled-tasks'
import type { EnterpriseWorkspace } from '../../../features/enterprise/useEnterpriseWorkspace'
import type { ScheduledTasksModel } from '../../../features/enterprise/use-scheduled-tasks'
import { canResumeSchedule, definitionLabel, recurrenceLabel, RUN_LABELS, runActions, scheduleTime, TERMINAL_RUNS } from '../../../features/enterprise/scheduled-task-model'
import { EmployeeFace } from '../EmployeeFace'
import { ScheduledOperationResults } from './ScheduledOperationResults'

function Plan({ plan }: { plan: ScheduledWorkPlan }) {
  if (plan.kind === 'arrangement') return <section className="ent-sch-card ent-sch-plan" aria-label="只读自动编排计划"><h3>自动编排计划 <small>只读</small></h3><p>{plan.title}</p>{plan.nodes.map((node, index) => <article key={node.id}><h4>{index + 1}. {node.title}</h4><p className="ent-sch-help">员工订阅：{node.subscriptionId} · 模型：{node.modelId}</p>{node.dependsOn.length ? <p className="ent-sch-help">依赖：{node.dependsOn.join('、')}</p> : null}<p>{node.objective ?? node.expectedOutput}</p><ul>{node.deliverables.map(file => <li key={file.id}><FileText size={16} /><div><strong>{file.name}</strong><code>{file.path}</code><p className="ent-sch-help">验收：{file.acceptanceCriteria.join('；')}</p></div></li>)}</ul><details><summary>查看执行指令</summary><p className="ent-sch-instruction">{node.instruction}</p></details></article>)}</section>
  return <section className="ent-sch-card ent-sch-plan" aria-label="只读工作计划"><h3>工作计划 <small>只读</small></h3><p>{plan.objective}</p><h4>最终成果</h4><p>{plan.expectedOutput}</p><ul>{plan.deliverables.map(file => <li key={file.id}><FileText size={16} /><div><strong>{file.name}</strong><code>{file.path}</code><ul>{file.contentOutline.map((text, index) => <li key={index}>{text}</li>)}</ul><p className="ent-sch-help">验收：{file.acceptanceCriteria.join('；')}</p></div></li>)}</ul><details><summary>查看完整执行指令</summary><p className="ent-sch-instruction">{plan.instruction}</p></details></section>
}

export function ScheduledTaskDetail({ definition, workspace, model, inHistory, onDelete }: { definition: ScheduledDefinition; workspace: EnterpriseWorkspace; model: ScheduledTasksModel; inHistory: boolean; onDelete(definition: ScheduledDefinition): void }) {
  const route = workspace.route.name === 'scheduled' ? workspace.route : { name: 'scheduled' as const }
  const tab = route.view === 'configuration' ? 'configuration' : 'history'
  const [confirming, setConfirming] = useState<'review' | 'cancel' | null>(null)
  const [confirmedRun, setConfirmedRun] = useState<string | null>(null)
  const confirmationRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!confirming) return
    confirmationRef.current?.focus({ preventScroll: true })
    confirmationRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  }, [confirming])

  const employee = workspace.myEmployees.find(item => item.id === definition.input.subscriptionId)
  const local = definition.input.mode === 'empty-text', general = definition.input.mode === 'general'
  const executor = local ? '旧版空白文本动作' : general ? '通用助手' : definition.input.mode === 'auto' ? '自动编排' : employee?.name ?? '员工暂不可用'
  const filename = definition.input.emptyText?.naming === 'fixed' ? definition.input.emptyText.filename
    : definition.input.emptyText?.naming === 'started' ? 'yyyyMMdd-HHmm.txt（启动时间）' : 'yyyyMMdd-HHmm.txt（计划时间）'
  const runs = model.data?.occurrences.filter(run => run.definitionId === definition.id).sort((a, b) => b.scheduledAt - a.scheduledAt) ?? []
  const active = runs.some(run => !TERMINAL_RUNS.has(run.status))
  const selected = runs.find(run => run.id === route.runId) ?? runs[0]
  const seenTime = runs.some(run => run.scheduledAt === definition.input.scheduledAt)
  const recurring = definition.input.recurrence?.frequency !== undefined && definition.input.recurrence.frequency !== 'once'
  const goTab = (view: 'configuration' | 'history') => { setConfirming(null); workspace.replaceRoute({ name: 'scheduled', taskId: definition.id, view, runId: route.runId }) }
  const openWork = (run: ScheduledOccurrence) => workspace.navigate({ name: 'work', workId: run.taskId })
  const perform = async () => {
    const result = confirming === 'review' && confirmedRun ? await model.acknowledge(confirmedRun) : confirming === 'cancel' && confirmedRun ? await model.cancel(confirmedRun) : null
    if (result?.success) { setConfirming(null); setConfirmedRun(null) }
  }

  return <div className="ent-sch-detail">
    <header className="ent-sch-detail-head"><div className="ent-sch-person">{!local && !general && <EmployeeFace employee={employee} size="md" round />}<div><h2>{definition.input.name}</h2><p>{executor} · {recurrenceLabel(definition)}</p></div></div><span className={`ent-sch-state ${definition.enabled && !inHistory ? 'enabled' : ''}`}>{definitionLabel(definition, inHistory)}</span></header>
    <div className="ent-sch-overview"><div><small>下次执行</small><strong>{scheduleTime(definition.nextRunAt, definition.input.timezone)}</strong></div><div><small>时区</small><strong>{definition.input.timezone}</strong></div><div><small>最近执行结果</small><strong>{runs[0] ? RUN_LABELS[runs[0].status] : '尚未执行'}</strong></div><div><small>执行记录</small><strong>{runs.length} 次</strong></div></div>
    <div className="ent-sch-tabs" role="tablist" aria-label="定时任务详情"><button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => goTab('history')}>执行记录</button><button type="button" role="tab" aria-selected={tab === 'configuration'} onClick={() => goTab('configuration')}>任务配置</button></div>
    {tab === 'configuration' ? <div className="ent-sch-config" role="tabpanel" aria-label="任务配置">
      <section className="ent-sch-card"><h3>任务配置</h3><dl className="ent-sch-facts"><div><dt>工作目标</dt><dd>{definition.input.goal}</dd></div><div><dt>执行时间</dt><dd>{scheduleTime(definition.input.scheduledAt, definition.input.timezone)} · {definition.input.timezone}</dd></div>{local ? <div><dt>文件名</dt><dd>{filename}</dd></div> : <div><dt>模型</dt><dd>{definition.input.modelId}</dd></div>}<div><dt>工作目录</dt><dd className="ent-sch-path" title={definition.input.workDir}>{definition.input.workDir}</dd></div>{definition.input.outputDirectory && <div><dt>产出目录（仅交付）</dt><dd className="ent-sch-path" title={definition.input.outputDirectory.path}>{definition.input.outputDirectory.path}</dd></div>}<div><dt>权限</dt><dd>{definition.input.permissions.preset === 'full-local' ? '旧版权限已停用，请重新保存任务' : local ? '仅创建新文件，不覆盖' : '在工作目录内创建文件，不修改已有文件'}</dd></div>{!local && <div><dt>技能</dt><dd>{general ? '不加载员工技能' : '执行时使用员工当前选择且有权使用的版本'}</dd></div>}<div><dt>配置版本</dt><dd>第 {definition.revision} 版 · 历史执行保留当时的快照</dd></div></dl></section>
      {definition.input.outputDirectory && !local && definition.input.permissions.preset !== 'full-local' && <p className="ent-sch-help">产出目录：同名文件先备份再覆盖，原件副本保存在同一目录。</p>}
      {local && !definition.deleted && <p className="ent-sch-help">{retiredScheduledExecutionMessage}</p>}
      {definition.input.actions?.length ? <section className="ent-sch-card"><h3>已停用的旧版发送配置</h3><ol className="ent-sch-attempts">{definition.input.actions.map((action, index) => <li key={index}>
        <strong>{action.targetType === 'person' ? '成员' : '群会话'} · <code className="ent-sch-path">{action.targetId}</code></strong><p className="ent-sch-instruction">{action.body}</p>
      </li>)}</ol></section> : null}
      {definition.plan ? <Plan plan={definition.plan} /> : !local && <section className="ent-sch-card"><h3>工作计划尚未生成</h3><p>{general ? '根据工作目标生成执行指令和文件交付要求。此步骤只做规划。' : '将根据员工职责和工作目标生成执行指令及文件交付要求。此步骤只做规划。'}</p>{!definition.deleted ? <button type="button" className="ent-btn primary" disabled={model.busy || active} onClick={() => void model.plan(definition)}>{model.busy ? '正在生成…' : '生成工作计划'}</button> : null}</section>}
      {!definition.deleted ? <footer className="ent-sch-actions">
        {definition.enabled ? <button type="button" className="ent-btn" disabled={model.busy} onClick={() => void model.pause(definition)}>暂停后续调度</button> : canResumeSchedule(definition, seenTime) ? <button type="button" className="ent-btn primary" disabled={model.busy || active} onClick={() => void model.confirm(definition)}>{recurring && seenTime ? '恢复周期调度' : '确认计划并启用'}</button> : null}
        <button type="button" className="ent-btn" disabled={model.busy || active} onClick={() => workspace.replaceRoute({ name: 'scheduled', taskId: definition.id, view: 'edit' })}><Pencil size={14} />编辑任务配置</button>
        <button type="button" className="ent-btn danger ghost" disabled={model.busy || active} onClick={() => onDelete(definition)}><Trash2 size={14} />删除任务</button>
      </footer> : <p className="ent-sch-help">该任务已删除，配置和执行记录仅供查阅。</p>}
      {active ? <p className="ent-sch-help">请先处理或停止当前执行，再修改或删除配置。暂停后续调度不会停止已经生成的执行。</p> : seenTime ? <p className="ent-sch-help">这个时间点已经执行过。再次安排请编辑原任务，选择未来时间并重新启用。</p> : definition.input.scheduledAt <= Date.now() && !definition.enabled ? <p className="ent-sch-help">原执行时间已过，请编辑为未来时间后启用。</p> : null}
    </div> : <div role="tabpanel" aria-label="执行记录">
      {!runs.length ? <div className="ent-sch-empty"><h3>还没有执行记录</h3>{!definition.deleted && <p>{definition.enabled ? '到达执行时间后会自动生成记录。' : '先在任务配置中生成工作计划并确认启用。'}</p>}<button type="button" className="ent-btn" onClick={() => goTab('configuration')}>查看任务配置</button></div> : <div className="ent-sch-history">
        <div className="ent-sch-timepoints" aria-label="执行时间点">{runs.map(run => <button type="button" key={run.id} className={selected?.id === run.id ? 'selected' : ''} aria-pressed={selected?.id === run.id} onClick={() => { setConfirming(null); workspace.replaceRoute({ name: 'scheduled', taskId: definition.id, view: 'history', runId: run.id }) }}><strong>{scheduleTime(run.scheduledAt, run.input.timezone)}</strong><span className={`ent-sch-status ${run.status}`}>{RUN_LABELS[run.status]}</span><small>{run.attempts.length} 次启动尝试</small></button>)}</div>
        {selected ? <section className="ent-sch-run" aria-label="本次执行详情"><header><h3>{scheduleTime(selected.scheduledAt, selected.input.timezone)}</h3><span className={`ent-sch-status ${selected.status}`}>{RUN_LABELS[selected.status]}</span></header><dl className="ent-sch-facts"><div><dt>开始时间</dt><dd>{scheduleTime(selected.startedAt, selected.input.timezone)}</dd></div><div><dt>结束时间</dt><dd>{scheduleTime(selected.finishedAt, selected.input.timezone)}</dd></div><div><dt>下次重试</dt><dd>{scheduleTime(selected.nextRetryAt, selected.input.timezone)}</dd></div><div><dt>原配置版本</dt><dd>第 {selected.revision} 版</dd></div></dl>
          {selected.error ? <div className={`ent-sch-notice ${selected.status === 'failed' ? 'error' : ''}`}><strong>{selected.error.message}</strong></div> : null}
          {selected.status === 'review' ? <p className="ent-sch-help">请核查已有文件和外部操作结果。确认关闭只结束记录，不会重新执行。</p> : selected.status === 'waiting_auth' ? <p className="ent-sch-help">请恢复登录与授权后重新检查。尚未启动的任务仍受启动期限限制。</p> : selected.status === 'waiting_approval' ? <p className="ent-sch-help">旧版执行进入了等待审批状态，调度器会停止本次等待，不会自动放行。</p> : null}
          <div className="ent-sch-actions">
            {workspace.works.some(work => work.id === selected.taskId) ? <button type="button" className="ent-btn primary" onClick={() => openWork(selected)}>查看工作详情与成果</button> : <span className="ent-sch-help">尚无可查看的工作详情</span>}
            {runActions(selected.status).includes('check') ? <button type="button" className="ent-btn" disabled={model.busy} onClick={() => void model.check(selected.id)}>重新检查执行条件</button> : null}
            {runActions(selected.status).includes('acknowledge') ? <button type="button" className="ent-btn" disabled={model.busy} onClick={() => { setConfirmedRun(selected.id); setConfirming('review') }}>核查后关闭本次执行</button> : null}
            {runActions(selected.status).includes('cancel') ? <button type="button" className="ent-btn danger ghost" disabled={model.busy} onClick={() => { setConfirmedRun(selected.id); setConfirming('cancel') }}>停止本次执行</button> : null}
          </div>
          <ScheduledOperationResults key={selected.id} run={selected} />
          <h4>启动尝试</h4>{!selected.attempts.length ? <p className="ent-sch-help">尚未开始启动检查。</p> : <ol className="ent-sch-attempts">{selected.attempts.map(attempt => <li key={attempt.id}><strong>第 {attempt.number} 次 · {({ preparing: '准备中', admitted: '已进入运行时', failed: selected.startedAt !== null && attempt.id === selected.attempts.at(-1)?.id ? '执行失败' : '启动失败', completed: '已完成', interrupted: '已中断' })[attempt.status]}</strong><small>{scheduleTime(attempt.startedAt, selected.input.timezone)} → {scheduleTime(attempt.finishedAt, selected.input.timezone)}</small>{attempt.error ? <p>{attempt.error.message}</p> : null}</li>)}</ol>}
          <details><summary>本次执行的配置快照</summary><p className="ent-sch-instruction">{selected.input.goal}</p><p className="ent-sch-path">{selected.input.workDir}</p><p className="ent-sch-help">{selected.input.mode === 'empty-text' ? '本地动作' : selected.input.mode === 'general' ? `通用助手 · ${selected.input.modelId}` : selected.input.modelId} · {selected.input.timezone}</p><Plan plan={selected.plan} /></details>
        </section> : null}
      </div>}
    </div>}
    {confirming ? <div ref={confirmationRef} tabIndex={-1} className="ent-sch-confirm" role="alertdialog" aria-label={confirming === 'review' ? '核查确认' : '停止执行'}><p>{confirming === 'review' ? '我已核查现有文件和外部操作，并确认关闭本次执行。此操作不会重跑任务。' : '停止本次执行？已产生的文件和外部操作不会自动撤回。'}</p><div className="ent-sch-actions"><button type="button" className="ent-btn" disabled={model.busy} onClick={() => setConfirming(null)}>返回</button><button type="button" className="ent-btn danger" disabled={model.busy} onClick={() => void perform()}>{confirming === 'review' ? '已核查，关闭记录' : '确认停止'}</button></div></div> : null}
  </div>
}
