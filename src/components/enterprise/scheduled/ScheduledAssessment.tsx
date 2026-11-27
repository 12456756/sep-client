import { useEffect, useState } from 'react'
import type { ScheduledOccurrence } from '../../../shared/scheduled-tasks'
import type { ArrangementExecutionSnapshot } from '../../../shared/types'
import { assessScheduledRun, scheduledDeliveryRunId } from '../../../features/enterprise/scheduled-assessment'
import { scheduledAttachmentEvidence, selectScheduledDeliveryEvent, type ScheduledAttachmentEvidence } from '../../../features/enterprise/scheduled-delivery-evidence'

export function ScheduledAssessment({ run, execution, scopeKey, inline = false }: { run: ScheduledOccurrence; execution?: ArrangementExecutionSnapshot | null; scopeKey: string; inline?: boolean }) {
  const nodeRunId = scheduledDeliveryRunId(run, execution)
  const key = JSON.stringify([scopeKey, run.id, run.taskId, nodeRunId])
  const [snapshot, setSnapshot] = useState<{ key: string; evidence: ScheduledAttachmentEvidence[] } | null>(null)
  const taskId = run.taskId
  useEffect(() => {
    if (!nodeRunId) return
    let current = true
    void (async () => {
      let evidence: ScheduledAttachmentEvidence[] = []
      try {
        const result = await window.electronAPI.getTaskTimeline(taskId, nodeRunId)
        if (current && result.success) {
          const events = (result.events ?? []).flatMap(event => {
            if (event.taskId !== taskId || event.runId !== nodeRunId) return []
            const projected = selectScheduledDeliveryEvent(event)
            return projected ? [projected] : []
          })
          evidence = scheduledAttachmentEvidence(events, taskId)
        }
      } catch { /* Missing history only makes the receipt unavailable to display. */ }
      if (current) setSnapshot({ key, evidence })
    })()
    return () => { current = false }
  }, [key, taskId, nodeRunId])

  let rows: ReturnType<typeof assessScheduledRun>
  try { rows = assessScheduledRun(run, execution, snapshot?.key === key ? snapshot.evidence : [], !!nodeRunId && snapshot?.key !== key) }
  catch { return <p className="ent-sch-help">暂时无法核对成果，本次执行状态不变。</p> }
  if (!rows.length) return null
  return <section className={`ent-sch-assessment${inline ? ' ent-flow-act' : ''}`} aria-label="成果核对">
    <h4>成果核对</h4>
    <ol className="ent-sch-attempts">{rows.map(({ title, label, detail }, index) => <li key={index}>
      <strong>{title} · {label}</strong><small>{detail}</small>
    </li>)}</ol>
  </section>
}
