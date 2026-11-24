import { createContext, useContext } from 'react'
import { z } from 'zod'
import type { ToolAuthorizationRequest } from '../../shared/types'

export const isInlineFileApproval = (tool: string) => tool === 'file_edit_once' || tool === 'file_select_original'
export const InlineFileApprovals = createContext<{ requests: ToolAuthorizationRequest[]; resolve(id: string, approved: boolean): void } | null>(null)
const requestInput = z.object({ path: z.string(), before: z.string().optional(), after: z.string().optional() })

export function InlineFileApproval({ taskId }: { taskId: string }) {
  const queue = useContext(InlineFileApprovals)
  if (!queue) return null
  return queue.requests.filter(request => request.taskId === taskId).map(request => {
    const input = requestInput.safeParse(request.input)
    if (!input.success) return null
    const pick = request.toolName === 'file_select_original'
    return <section className="ent-wk-file-approval" key={request.requestId} aria-label="文件操作审批">
      <strong role="status">等待审批</strong>
      <p>{pick ? '请选择要访问的原文件' : '是否允许应用下列改动？'}：<bdi>{input.data.path}</bdi></p>
      {!pick && <details><summary>查看改动</summary><div className="ent-wk-file-diff">
        <div><strong>修改前</strong><pre>{input.data.before}</pre></div>
        <div><strong>修改后</strong><pre>{input.data.after}</pre></div>
      </div></details>}
      <div className="ent-wk-file-actions">
        <button type="button" className="ent-btn sm" onClick={() => queue.resolve(request.requestId, false)}>拒绝</button>
        <button type="button" className="ent-btn sm primary" onClick={() => queue.resolve(request.requestId, true)}>{pick ? '选择原文件' : '允许一次'}</button>
      </div>
    </section>
  })
}
