import { connectorIdSchema } from '../../../src/shared/connectors'
import { INVOKE_CHANNELS } from '../channels'
import { route } from '../router'

export const connectorRoutes = [
  route(INVOKE_CHANNELS.CONNECTOR_STATE, connectorIdSchema, async (ctx, id) => ({ success: true, data: await ctx.connectors.state(id) }), { trustedMainFrame: true }),
  route(INVOKE_CHANNELS.CONNECTOR_CONNECT, connectorIdSchema, async (ctx, id) => { await ctx.connectors.connect(id); return { success: true } }, { trustedMainFrame: true }),
  route(INVOKE_CHANNELS.CONNECTOR_DISCONNECT, connectorIdSchema, async (ctx, id) => { await ctx.connectors.disconnect(id); return { success: true } }, { trustedMainFrame: true }),
]
