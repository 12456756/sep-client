import type { EffectiveTaskPermissionPolicy } from '../domain/arrangement-plan'
import type { TaskToolPolicy } from './run-types'
import type { ResolvedAttachmentInput } from '../domain/attachment-input'

export function runtimeOriginalFiles(policy: TaskToolPolicy | undefined, attachments: readonly ResolvedAttachmentInput[]) {
  const editable = !policy || policy.preset === 'read-only' || policy.unattended ? [] : attachments.filter(item => item.originalFile)
  return {
    bindings: new Map(editable.map(item => [`@original/${item.attachmentId}`, item.originalFile!])),
    prompt: editable.length ? `\n\n【附件原件】仅在用户明确要求修改原件时，使用下列标识作为 edit 或 write 的 path。每次实际改动仍需用户批准；附件快照本身不可修改。\n${JSON.stringify(editable.map(item => ({ name: item.displayName, path: `@original/${item.attachmentId}` })))}` : '',
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
