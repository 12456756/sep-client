import { z } from 'zod'
import {
  AuthApiError,
  createPersonalRecharge,
  getClientProfile,
  getPersonalRecharge,
  reconcilePersonalRecharge,
  uploadEnterpriseLogo,
  uploadUserAvatar,
} from '../../common/platform/platform-api'
import { AuthenticationRequiredError } from '../../common/platform/authentication-required-error'
import {
  personalRechargeQuerySchema,
  personalRechargeRequestSchema,
} from '../../../src/shared/profile-wallet-contracts'
import type { RequestContext } from '../request-context'
import { INVOKE_CHANNELS } from '../channels'
import { NO_INPUT, route } from '../router'

const imageMimeTypes = ['image/png', 'image/jpeg', 'image/webp'] as const
const imageExtensions: Record<(typeof imageMimeTypes)[number], readonly string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
}

const uploadInputSchema = z.object({
  bytes: z.instanceof(Uint8Array)
    .refine(bytes => bytes.byteLength > 0 && bytes.byteLength <= 2 * 1024 * 1024, '图片大小必须大于 0 且不超过 2 MB'),
  filename: z.string().trim().min(1).max(255)
    .refine(filename => filename === filename.split(/[\\/]/).pop(), '图片文件名无效'),
  contentType: z.enum(imageMimeTypes),
}).superRefine((input, ctx) => {
  const extension = input.filename.slice(input.filename.lastIndexOf('.')).toLowerCase()
  if (!imageExtensions[input.contentType].includes(extension)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filename'], message: '图片扩展名与 MIME 类型不匹配' })
  }
})

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

export const profileWalletRoutes = [
  route(INVOKE_CHANNELS.PROFILE_GET, NO_INPUT, withAuth(async (_ctx, accessToken, _input: undefined) =>
    getClientProfile(accessToken))),
  route(INVOKE_CHANNELS.PROFILE_UPLOAD_AVATAR, uploadInputSchema, withAuth(async (_ctx, accessToken, input) =>
    uploadUserAvatar(input, accessToken))),
  route(INVOKE_CHANNELS.PROFILE_UPLOAD_ENTERPRISE_LOGO, uploadInputSchema, withAuth(async (_ctx, accessToken, input) =>
    uploadEnterpriseLogo(input, accessToken))),
  route(INVOKE_CHANNELS.WALLET_CREATE_RECHARGE, personalRechargeRequestSchema, withAuth(async (_ctx, accessToken, input) =>
    createPersonalRecharge(input, accessToken))),
  route(INVOKE_CHANNELS.WALLET_GET_RECHARGE, personalRechargeQuerySchema, withAuth(async (_ctx, accessToken, orderNo) =>
    getPersonalRecharge(orderNo, accessToken))),
  route(INVOKE_CHANNELS.WALLET_RECONCILE_RECHARGE, personalRechargeQuerySchema, withAuth(async (_ctx, accessToken, orderNo) =>
    reconcilePersonalRecharge(orderNo, accessToken))),
]
