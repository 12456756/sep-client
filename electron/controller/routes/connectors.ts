import { connectorIdSchema, gitHubCredentialsSchema, qqMailCredentialsSchema } from '../../../src/shared/connectors'
import { INVOKE_CHANNELS } from '../channels'
import { route } from '../router'

export const connectorRoutes = [
  route(INVOKE_CHANNELS.CONNECTOR_STATE, connectorIdSchema, async (ctx, id) => ({ success: true, data: await ctx.connectors.state(id) }), { trustedMainFrame: true }),
  route(INVOKE_CHANNELS.CONNECTOR_CONNECT, connectorIdSchema, async (ctx, id) => { await ctx.connectors.connect(id); return { success: true } }, { trustedMainFrame: true }),
  route(INVOKE_CHANNELS.CONNECTOR_QQ_MAIL_CONNECT, qqMailCredentialsSchema, async (ctx, credentials) => { await ctx.connectors.connectQQMail(credentials); return { success: true } }, { trustedMainFrame: true }),
  route(INVOKE_CHANNELS.CONNECTOR_GITHUB_CONNECT, gitHubCredentialsSchema, async (ctx, credentials) => { await ctx.connectors.connectGitHub(credentials); return { success: true } }, { trustedMainFrame: true, invalidMessage: '请输入有效的 GitHub 个人访问令牌并选择访问模式。' }),
  route(INVOKE_CHANNELS.CONNECTOR_DISCONNECT, connectorIdSchema, async (ctx, id) => { await ctx.connectors.disconnect(id); return { success: true } }, { trustedMainFrame: true }),
]
