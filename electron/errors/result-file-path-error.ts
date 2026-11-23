import { AppError } from './app-error'
import type { ErrorCode } from './error-codes'

const failures = {
  outside: ['PERMISSION_DENIED', '产出文件不在本次工作的目录内。'],
  link: ['PERMISSION_DENIED', '产出文件路径包含链接，客户端无法访问。'],
  notFile: ['INVALID_ARGUMENT', '产出记录未指向普通文件。'],
  invalidPath: ['INVALID_ARGUMENT', '产出文件路径无效。'],
  missing: ['NOT_FOUND', '找不到产出文件，请确认它仍保存在原位置。'],
  workspaceUnavailable: ['WORKSPACE_INVALID', '本次工作的目录不存在或不可用。'],
  access: ['PERMISSION_DENIED', '系统未允许访问产出文件或其目录，请检查文件夹权限。'],
} as const satisfies Record<string, readonly [ErrorCode, string]>

export class ResultFilePathError extends AppError {
  constructor(readonly reason: keyof typeof failures, cause?: unknown) {
    const [code, message] = failures[reason]
    super(code, { message, cause, details: { reason } })
  }
}

export function resultFileSystemError(error: unknown): ResultFilePathError | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined
  if (error.code === 'ENOENT') return new ResultFilePathError('missing', error)
  if (error.code === 'ENOTDIR') return new ResultFilePathError('notFile', error)
  if (error.code === 'EACCES' || error.code === 'EPERM') return new ResultFilePathError('access', error)
  if (error.code === 'ELOOP') return new ResultFilePathError('link', error)
  return undefined
}
