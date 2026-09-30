import { z } from 'zod'
import {
  AuthApiError,
  getComputeUsageBreakdown,
  getComputeUsageRecords,
  getMyComputeAllowance,
  getPersonalWallet,
  getPersonalWalletTransactions,
} from '../../common/platform/platform-api'
import { AuthenticationRequiredError } from '../../common/platform/authentication-required-error'
import {
  computeBreakdownDaysSchema,
  computePageQuerySchema,
  computeUsageQuerySchema,
} from '../../../src/shared/compute-credit-contracts'
import type { RequestContext } from '../request-context'
import { INVOKE_CHANNELS } from '../channels'
import { NO_INPUT, route } from '../router'

function withAuth<TInput, TResult>(
  handler: (ctx: RequestContext, accessToken: string, input: TInput) => Promise<TResult>,
): (ctx: RequestContext, input: TInput) => Promise<{ success: true; data: TResult }> {
  return async (ctx, input) => {
    try {
      const accessToken = await ctx.backend.authSession.getValidAccessToken()
      return { success: true, data: await handler(ctx, accessToken, input) }
    } catch (error) {
      if (error instanceof AuthenticationRequiredError || (error instanceof AuthApiError && error.isUnauthorized)) {
        ctx.backend.invalidateAuthentication()
      }
      throw error
    }
  }
}

export const computeCreditRoutes = [
  route(INVOKE_CHANNELS.COMPUTE_CENTER_GET_OVERVIEW, NO_INPUT, withAuth(async (_ctx, accessToken, _input: undefined) => {
    const [allowance, wallet, breakdown] = await Promise.all([
      getMyComputeAllowance(accessToken),
      getPersonalWallet(accessToken),
      getComputeUsageBreakdown(accessToken, 30),
    ])
    return { allowance, wallet, breakdown }
  })),
  route(INVOKE_CHANNELS.COMPUTE_CENTER_GET_TRANSACTIONS, computePageQuerySchema, withAuth(async (_ctx, accessToken, input) =>
    getPersonalWalletTransactions(accessToken, input))),
  route(INVOKE_CHANNELS.COMPUTE_CENTER_GET_USAGE_RECORDS, computeUsageQuerySchema, withAuth(async (_ctx, accessToken, input) =>
    getComputeUsageRecords(accessToken, input))),
  route(
    INVOKE_CHANNELS.COMPUTE_CENTER_GET_BREAKDOWN,
    z.object({ days: computeBreakdownDaysSchema }),
    withAuth(async (_ctx, accessToken, input) => getComputeUsageBreakdown(accessToken, input.days)),
  ),
]
