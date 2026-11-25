/** @jsxRuntime automatic */
import { createContext, useContext } from 'react'
import { z } from 'zod'
import type { ToolAuthorizationRequest } from '../../shared/types'
import { ORIGINAL_DOCUMENT_REPLACE_TOOL } from '../../shared/python-tool'

export const isInlineFileApproval = (tool: string) => tool === 'file_edit_once' || tool === 'file_select_original' || tool === 'file_save_as' || tool === ORIGINAL_DOCUMENT_REPLACE_TOOL
export const InlineFileApprovals = createContext<{ requests: ToolAuthorizationRequest[]; resolve(id: string, approved: boolean): void } | null>(null)
const requestInput = z.object({ path: z.string(), before: z.string().optional(), after: z.string().optional() })
const replacementInput = z.object({ path: z.string(), backup: z.string(), purpose: z.string().max(240), beforeBytes: z.number().int().positive(), afterBytes: z.number().int().positive() })
const formatSize = new Intl.NumberFormat('zh-CN', { style: 'unit', unit: 'byte' })

export function InlineFileApproval({ taskId }: { taskId: string }) {
  const queue = useContext(InlineFileApprovals)
  if (!queue) return null
  return queue.requests.filter(request => request.taskId === taskId).map(request => {
    const input = requestInput.safeParse(request.input)
    if (!input.success) return null
    const pick = request.toolName === 'file_select_original'
    const save = request.toolName === 'file_save_as'
    const replace = request.toolName === ORIGINAL_DOCUMENT_REPLACE_TOOL
    const document = replace ? replacementInput.safeParse(request.input).data : undefined
    return <section className="ent-wk-file-approval" key={request.requestId} aria-label="文件操作审批">
      <strong role="status">等待审批</strong>
      <p>{replace ? '替换本地原件' : save ? '另存文件到指定位置' : pick ? '请选择要访问的原文件' : '是否允许应用下列改动？'}：<bdi>{input.data.path}</bdi></p>
      {document && <>
        <p>AI 提出的改动：<bdi>{document.purpose}</bdi></p>
        <p>文件大小：{formatSize.format(document.beforeBytes)} → {formatSize.format(document.afterBytes)}</p>
        <p>备份位置：<bdi>{document.backup}</bdi></p>
      </>}
      {!pick && !save && !replace && <details><summary>查看改动</summary><div className="ent-wk-file-diff">
        <div><strong>修改前</strong><pre>{input.data.before}</pre></div>
        <div><strong>修改后</strong><pre>{input.data.after}</pre></div>
      </div></details>}
      <div className="ent-wk-file-actions">
        <button type="button" className="ent-btn sm" onClick={() => queue.resolve(request.requestId, false)}>拒绝</button>
        <button type="button" className="ent-btn sm primary" disabled={replace && !document} onClick={() => queue.resolve(request.requestId, true)}>{replace ? '备份并替换' : save ? '另存为' : pick ? '选择原文件' : '允许一次'}</button>
      </div>
    </section>
  })
}
