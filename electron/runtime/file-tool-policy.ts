import type { EffectiveTaskPermissionPolicy } from '../domain/arrangement-plan'
import type { TaskToolPolicy } from './run-types'
import type { ResolvedAttachmentInput } from '../domain/attachment-input'

export function runtimeAttachmentReadScope(attachments: readonly ResolvedAttachmentInput[]) {
  const attachmentNamesByPath = new Map(attachments.flatMap(item => item.readPath ? [[item.readPath, item.displayName] as const] : []))
  return { readableAttachmentPaths: [...attachmentNamesByPath.keys()], attachmentNamesByPath }
}

export function runtimeOriginalFiles(policy: TaskToolPolicy | undefined, attachments: readonly ResolvedAttachmentInput[]) {
  const editable = !policy || policy.preset === 'read-only' || policy.unattended ? [] : attachments.filter(item => item.originalFile)
  const approval = policy?.fileAccess === 'local' ? '本次已获完全访问授权，无需另行确认。' : '每次实际改动仍需用户批准。'
  const catalog = editable.map(item => ({ name: item.displayName, path: `@original/${item.attachmentId}` }))
  return {
    bindings: new Map(editable.map(item => [`@original/${item.attachmentId}`, item.originalFile!])),
    prompt: attachments.length ? `\n\n【本轮附件原件】仅本轮清单中的原件标识有效，忽略历史清单。读取来源附件时使用 conversation_attachment 的 read 或 xlsx 操作；向 run_python 的 inputs 传入 read 返回的 readOnlyPath，不要传入原件标识。附件快照不可修改。\n${JSON.stringify(catalog)}\n` + (editable.length
      ? `仅在用户明确要求修改原件时使用本轮标识。纯文本使用 edit 或 write 的 path：${approval}DOCX、XLSX、PPTX、PDF 仅使用 run_python 的 replaceOriginal 参数写回，始终单独审批并保留备份；不要把原件标识传给 OfficeCLI。若没有该参数，不要尝试绕过。工具未确认写回时不要声称原件已修改。`
      : (policy?.preset === 'read-only' || policy?.unattended) ? '本轮权限不允许修改附件原件。' : '本轮没有绑定可写回的附件原件。若用户要求覆盖，只请用户将目标原件重新拖入本对话，或用“+”重新从电脑选择该文件。来源附件不必重传；不要重试旧标识、猜测磁盘路径或要求开启完全访问。') : '',
  }
}

export function runtimeFileToolPolicy(
  saved: EffectiveTaskPermissionPolicy | undefined,
  workspaceDir: string,
  options: { fullFileAccess?: boolean; unattended?: boolean; applicationDataRoot?: string } = {},
): TaskToolPolicy {
  const readOnly = saved?.preset === 'read-only'
  const local = !readOnly && saved?.preset === 'full-local' && options.fullFileAccess === true && !options.unattended
  return {
    preset: readOnly ? 'read-only' : 'workspace-edit',
    allowedTools: [...new Set([
      ...(saved?.allowedTools ?? ['read', 'grep', 'find', 'ls', 'write', 'edit']).filter(tool => tool !== 'bash'),
      // The media services still check employee grants, quotations and separate approvals.
      ...(!readOnly && !options.unattended ? ['media_generate_image', 'media_cancel_job', 'video_generate', 'video_from_image', 'video_get_job'] : []),
    ])],
    allowedPaths: [...(saved?.allowedPaths ?? [])],
    deniedPaths: [...(saved?.deniedPaths ?? [])],
    commandPolicy: 'disabled', approvalMode: 'confirm-each', workspaceDir,
    fileAccess: local ? 'local' : 'workspace', unattended: options.unattended, applicationDataRoot: options.applicationDataRoot,
  }
}
