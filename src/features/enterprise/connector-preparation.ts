import type { ConnectorState } from '../../shared/connectors'

export function connectorPreparationText(state: ConnectorState): string | undefined {
  if (state.status !== 'preparing') return undefined
  if (!state.dependency) return '正在准备连接器'
  const { phase, received, total } = state.dependency
  if (phase === 'verifying') return '正在校验连接器组件'
  return `正在下载组件 ${Math.floor(received / total * 100)}%（${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB）`
}
