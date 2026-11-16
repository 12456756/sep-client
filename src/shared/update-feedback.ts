export const UPDATE_FAILURE_REASONS = ['network', 'timeout', 'disk_space', 'permission', 'verification', 'source_unavailable', 'unknown'] as const
export type UpdateFailureReason = typeof UPDATE_FAILURE_REASONS[number]
export type UpdateFeedbackOperation = 'check' | 'download' | 'cancel' | 'install'

export function updateFailureMessage(operation: UpdateFeedbackOperation, reason: UpdateFailureReason): string {
  if (reason === 'network') return '更新服务连接失败，请检查网络后重试。'
  if (reason === 'timeout') return '更新服务连接超时，请稍后重试。'
  if (reason === 'disk_space') return '磁盘空间不足，无法完成更新，请清理空间后重试。'
  if (reason === 'permission') return '没有更新文件或安装目录的访问权限，请检查系统权限后重试。'
  if (reason === 'verification') return '更新包校验未通过，请重新下载；持续失败请联系平台管理员。'
  if (reason === 'source_unavailable') return '当前版本的更新文件不可用，请稍后重试或联系平台管理员。'
  return {
    check: '检查更新失败，请稍后重试。', download: '下载更新失败，请稍后重试。',
    cancel: '取消下载失败，请稍后重试。', install: '安装更新失败，请稍后重试或手动下载新版本。',
  }[operation]
}

const commandMessages = new Set([
  '更新已下载，请安装或重启客户端后重新检查。', '请先检查并选择可用更新。', '当前没有可取消的下载。',
  '更新尚未下载完成，无法安装。', '更新状态已改变，请重新检查。',
  '当前开发环境或平台不支持自动更新，请手动下载新版本。', '更新操作正在进行，请稍后重试。',
  '无法确认任务状态，请稍后重试。', '仍有运行、排队或待审批的任务，请结束任务后再安装更新。',
  '自动更新服务暂不可用',
  ...(['check', 'download', 'cancel', 'install'] as const).flatMap(operation => UPDATE_FAILURE_REASONS.map(reason => updateFailureMessage(operation, reason))),
])

/** Only locally defined feedback is accepted; arbitrary IPC/SDK diagnostics stay hidden. */
export function safeUpdateCommandMessage(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('message' in value)) return null
  return typeof value.message === 'string' && commandMessages.has(value.message) ? value.message : null
}
