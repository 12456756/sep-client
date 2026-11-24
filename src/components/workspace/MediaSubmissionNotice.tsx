import { TriangleAlert } from 'lucide-react'
import type { mediaUnconfirmedNotice } from '../../shared/media-feedback'

export function MediaSubmissionNotice({ notice }: { notice: NonNullable<ReturnType<typeof mediaUnconfirmedNotice>> }) {
  return <div className="media-submission-notice">
    <TriangleAlert size={18} aria-hidden />
    <div>
      <div role="alert"><strong>{notice.title}</strong><p>{notice.advice}。<b>核实前请勿重复提交。</b></p></div>
      {notice.detail && <details><summary>查看异常原因</summary><p>{notice.detail}</p></details>}
    </div>
  </div>
}
