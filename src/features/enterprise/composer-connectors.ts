import type { ConnectorId } from '../../shared/connectors'

export const composerConnectorNames: Record<ConnectorId, string> = {
  dingtalk: '钉钉',
  feishu: '飞书',
  wecom: '企业微信',
  tmeet: '腾讯会议',
  qqmail: 'QQ 邮箱',
}

export function withComposerConnector(text: string, connectorId?: ConnectorId): string {
  const prompt = text.trim()
  return connectorId ? `请使用${composerConnectorNames[connectorId]}连接器完成以下需求：\n\n${prompt}` : prompt
}
