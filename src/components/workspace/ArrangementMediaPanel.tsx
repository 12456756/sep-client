import type { ArrangementMediaSummary } from '../../shared/types'
import type { WorkDeliverable } from '../../features/enterprise/types'

function phaseLabel(phase: ArrangementMediaSummary['phase']): string {
  switch (phase) {
    case 'preparing': return '准备中'
    case 'awaiting-approval': return '等待确认'
    case 'submitted': return '等待生成'
    case 'tracking': return '生成中'
    case 'saving': return '保存中'
    case 'materializing': return '整理结果中'
    case 'ready': return '正在整理交付'
    case 'blocked': return '交付受阻'
  }
}

export function ArrangementMediaPanel({ media, deliverables }: { media: ArrangementMediaSummary[]; deliverables: WorkDeliverable[] }) {
  const delivered = new Set(deliverables.flatMap(file => file.sourceArtifact ? [`${file.nodeId}:${file.sourceArtifact.artifactId}`] : []))
  const pending = media.filter(summary => {
    if (summary.phase !== 'ready') return true
    // Final files come only from accepted nodes; extra generated candidates are not pending deliveries.
    if (deliverables.some(file => file.nodeId === summary.nodeId)) return false
    return summary.outputs.some(output => output.status === 'saved' && !delivered.has(`${summary.nodeId}:${output.artifactId}`))
  })
  if (!pending.length) return null
  return <section className="arrangement-media-statuses" aria-label="编排媒体状态">
    {pending.map(summary => <p className={`media-result-status${summary.phase === 'blocked' ? ' error' : ''}`} role={summary.phase === 'blocked' ? 'alert' : 'status'} key={`${summary.nodeRunId}:${summary.jobId}`}>
      {summary.kind === 'image' ? '图片' : '视频'} · {phaseLabel(summary.phase)}
    </p>)}
  </section>
}
