/**
 * electron/controller/routes/auth.routes.ts — 6 条认证路由
 *
 * 认证路由保留在控制层，因为它直接使用 Electron 的 `safeStorage` 和凭据保险库；
 * 任务、对话和安排用例则通过 service 层处理。
 */
import { app, safeStorage } from 'electron'
import { z } from 'zod'
import { AuthApiError, login } from '../../common/platform/platform-api'
import { AuthenticationRequiredError } from '../../common/platform/authentication-required-error'
import { getDeviceFingerprint } from '../../common/platform/device-fingerprint'
import {
  forgetRememberedAccount,
  getRememberedPassword,
  listRememberedAccounts,
  saveRememberedAccount,
} from '../../common/platform/credential-vault'
import { authFailure } from '../../errors/error-mapper'
import type {
  ForgetAccountResult,
  LoginResult,
  LogoutResult,
  PasswordAvailabilityResult,
  RememberedAccountsResult,
} from '../../../src/shared/types'
import { INVOKE_CHANNELS } from '../channels'
import { NO_INPUT, route } from '../router'

/** 邮箱统一小写去空白后再校验；长度上限 254 是 RFC 5321 的地址上限。 */
const email = z.string().trim().toLowerCase().pipe(z.string().email().max(254))

/**
 * 登录入参。`useSavedPassword` 与 `password` 互斥：用保存的密码时不许再带一个，
 * 否则"到底用哪个"就成了两处判断（原 handler 里逐条写的那组条件）。
 */
const loginInput = z.union([
  z.object({
    email,
    password: z.string(),
    rememberPassword: z.boolean(),
    useSavedPassword: z.literal(false),
  }),
  z.object({
    email,
    password: z.undefined().optional(),
    rememberPassword: z.boolean(),
    useSavedPassword: z.literal(true),
  }),
])

export const authRoutes = [
  route(INVOKE_CHANNELS.AUTH_LOGIN, loginInput, async (ctx, input): Promise<LoginResult> => {
    if (input.rememberPassword && !safeStorage.isEncryptionAvailable()) {
      return authFailure('STORAGE_UNAVAILABLE')
    }
    const password = input.useSavedPassword ? getRememberedPassword(input.email) : input.password
    if (!password) return authFailure('INVALID_ARGUMENT', '请重新输入密码。')

    try {
      const response = await login({
        email: input.email,
        password,
        fingerprint: getDeviceFingerprint(),
        platform: process.platform,
        clientVersion: app.getVersion(),
      })
      // 平台返回体的形状不在契约里保证，逐字段确认后才敢建立会话。
      if (
        !response || typeof response.accessToken !== 'string' || typeof response.refreshToken !== 'string' ||
        !response.user || typeof response.user.id !== 'string' || typeof response.user.name !== 'string' ||
        typeof response.user.email !== 'string' || !response.enterprise ||
        typeof response.enterprise.id !== 'string' || typeof response.enterprise.name !== 'string'
      ) {
        return authFailure('SERVICE_UNAVAILABLE', '服务返回了无法识别的响应。')
      }

      await ctx.backend.stopAll()
      ctx.backend.authSession.setLogin(response)
      await ctx.backend.taskManager.setCurrentUser(response.user.id, response.enterprise.id)
      ctx.backend.employees.clear()
      saveRememberedAccount(
        {
          email: response.user.email || input.email,
          displayName: response.user.name,
          enterpriseName: response.enterprise.name,
        },
        password,
        input.rememberPassword,
      )
      return { success: true, data: { user: response.user, enterprise: response.enterprise } }
    } catch (error) {
      // 登录失败必须把半成品会话清干净，否则下一次调用会带着一个坏令牌走。
      ctx.backend.authSession.clear()
      ctx.backend.taskManager.clearCurrentUser()
      throw error
    }
  }, { invalidMessage: '登录请求参数不合法。', errorShape: 'auth' }),

  route(INVOKE_CHANNELS.AUTH_LIST_REMEMBERED_ACCOUNTS, NO_INPUT, (): RememberedAccountsResult => ({
    accounts: listRememberedAccounts(),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  }), { errorShape: 'reject' }),

  // 非邮箱一律当"没有保存的密码"，与原 handler 的 normalizeEmail 行为一致：
  // 这个通道是登录页填充用的，不该因为一个脏值把 invoke 打成 reject。
  route(INVOKE_CHANNELS.AUTH_GET_REMEMBERED_PASSWORD, email.catch(''), (_ctx, value): PasswordAvailabilityResult => ({
    passwordAvailable: value ? Boolean(getRememberedPassword(value)) : false,
  }), { errorShape: 'reject' }),

  route(INVOKE_CHANNELS.AUTH_FORGET_ACCOUNT, email, (_ctx, value): ForgetAccountResult => {
    forgetRememberedAccount(value)
    return { success: true, data: null }
  }, { invalidMessage: '请输入有效的邮箱地址。', errorShape: 'auth' }),

  route(INVOKE_CHANNELS.AUTH_LOGOUT, NO_INPUT, async (ctx): Promise<LogoutResult> => {
    await ctx.backend.signOut()
    return { success: true, data: null }
  }, { errorShape: 'auth' }),

  route(INVOKE_CHANNELS.AUTH_GET_INSTANCES, NO_INPUT, async ctx => {
    try {
      return { success: true, data: await ctx.employees.refresh() }
    } catch (error) {
      // 401 必须触发失效清理，否则用户停在一个令牌已作废的界面上。
      // 403 不算——那是权限不足，重新登录也不会变。
      if (
        error instanceof AuthenticationRequiredError ||
        (error instanceof AuthApiError && error.isUnauthorized)
      ) {
        ctx.backend.invalidateAuthentication()
      }
      throw error
    }
  }),
]


