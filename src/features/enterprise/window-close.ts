import { useEffect } from 'react'
import { useFeedback } from '../../components/feedback/FeedbackProvider'
import type { FeedbackController } from '../../shared/feedback-controller'
import type { ElectronAPI } from '../../shared/ipc'

export const windowClosePreferenceChanged = 'window-close-preference-changed'

export async function confirmWindowClose(
  feedback: Pick<FeedbackController, 'confirm'>,
  send: ElectronAPI['windowClose'],
  requestId: number,
  onRemember: () => void,
): Promise<void> {
  const finish = (action: 'minimize' | 'quit') => async (_value: string, remember: boolean) => {
    try {
      const result = await send({ type: 'resolve', requestId, action, remember })
      if (!result.success) return { success: false, message: result.error?.message ?? '无法执行关闭操作，请重试。' }
      if (remember) onRemember()
      return { success: true }
    } catch {
      return { success: false, message: '无法执行关闭操作，请重试。' }
    }
  }
  const accepted = await feedback.confirm({
    key: `window-close:${requestId}`,
    title: '关闭窗口',
    message: '最小化后，客户端和正在运行的任务会继续运行。直接退出将停止客户端。',
    actionLabel: '最小化',
    busyLabel: '正在最小化',
    onConfirm: finish('minimize'),
    alternate: { label: '直接退出', busyLabel: '正在退出', onConfirm: finish('quit') },
    checkboxLabel: '不再提示',
    cancelPlacement: 'corner',
  })
  if (!accepted) await send({ type: 'resolve', requestId, action: 'cancel', remember: false }).catch(() => {})
}

export function useWindowClosePrompt(): void {
  const feedback = useFeedback()
  useEffect(() => {
    const api = window.electronAPI
    return api?.onWindowCloseRequested?.(requestId => {
      void confirmWindowClose(feedback, api.windowClose, requestId,
        () => window.dispatchEvent(new Event(windowClosePreferenceChanged)))
    })
  }, [feedback])
}
