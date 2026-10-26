/**
 * electron/controller/routes/auth.routes.ts — 6 条认证路由
 *
 * 认证路由保留在控制层，因为它直接使用 Electron 的 `safeStorage` 和凭据保险库；
 * 任务、对话和安排用例则通过 service 层处理。
 */
import { app, safeStorage } from 'electron'
import { z } from 'zod'
import { AuthApiError, getEmployeeSkills, getEmployeeStatus, getEnterpriseOrganization, login, previewSkill } from '../../common/platform/platform-api'
import { AuthenticationRequiredError } from '../../common/platform/authentication-required-error'
import { LoginFeedbackError } from '../../common/platform/login-error'
import { getDeviceFingerprint } from '../../common/platform/device-fingerprint'
import {
  forgetRememberedAccount,
  getRememberedPassword,
  listRememberedAccounts,
  saveRememberedAccount,
} from '../../common/platform/credential-vault'
import { reportAuthFailure } from '../../errors/error-reporter'
import { logger } from '../../common/logger'
import { describeError } from '../../common/redact'
import type {
  ForgetAccountResult,
  LoginResult,
  LogoutResult,
  PasswordAvailabilityResult,
  RememberedAccountsResult,
  RememberedPasswordResult,
} from '../../../src/shared/types'
import { INVOKE_CHANNELS } from '../channels'
import { NO_INPUT, route } from '../router'

/** 邮箱统一小写去空白后再校验；长度上限 254 是 RFC 5321 的地址上限。 */
const email = z.string().trim().toLowerCase().pipe(z.string().email().max(254))
const log = logger.child('auth-route')

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
    if (!safeStorage.isEncryptionAvailable()) {
      throw new LoginFeedbackError('storage_unavailable')
    }
    const password = input.useSavedPassword ? getRememberedPassword(input.email) : input.password
    if (!password) throw new LoginFeedbackError(input.useSavedPassword ? 'saved_password_missing' : 'password_required')

    let fingerprint: string
    try { fingerprint = getDeviceFingerprint() }
    catch (error) { throw new LoginFeedbackError('device', error) }

    try {
      const response = await login({
        email: input.email,
        password,
        fingerprint,
        platform: process.platform,
        clientVersion: app.getVersion(),
      })
      // Keep the session boundary defensive even when the platform client is substituted.
      if (
        !response || typeof response.accessToken !== 'string' || typeof response.refreshToken !== 'string' ||
        !response.user || typeof response.user.id !== 'string' || typeof response.user.name !== 'string' ||
        typeof response.user.email !== 'string' ||
        (response.enterprise !== null && (!response.enterprise || typeof response.enterprise.id !== 'string' || typeof response.enterprise.name !== 'string'))
      ) {
        throw new LoginFeedbackError('response_invalid')
      }
      if (!response.enterprise) throw new LoginFeedbackError('enterprise_missing')

      try { await ctx.backend.stopAll() }
      catch (error) { throw new LoginFeedbackError('workspace', error) }
      if (!safeStorage.isEncryptionAvailable()) throw new LoginFeedbackError('storage_unavailable')
      try { ctx.backend.authSession.setLogin(response) }
      catch (error) { throw new LoginFeedbackError('credential_save', error) }
      try {
        await ctx.backend.taskManager.setCurrentUser(response.user.id, response.enterprise.id, {
          memberName: response.user.name,
          enterpriseName: response.enterprise.name,
        })
        ctx.backend.employees.clear()
      } catch (error) { throw new LoginFeedbackError('workspace', error) }
      try {
        saveRememberedAccount(
          {
            email: response.user.email || input.email,
            displayName: response.user.name,
            enterpriseName: response.enterprise.name,
          },
          password,
          input.rememberPassword,
        )
      } catch (error) { throw new LoginFeedbackError('credential_save', error) }
      void ctx.backend.resumeClientMonitor().catch(error => {
        log.warn('client monitor resume failed', { cause: describeError(error) })
      })
      return { success: true, data: { user: response.user, enterprise: response.enterprise } }
    } catch (error) {
      // 登录失败必须把半成品会话清干净，否则下一次调用会带着一个坏令牌走。
      try { ctx.backend.authSession.clear() }
      catch (cleanupError) { log.warn('login session cleanup failed', { cause: describeError(cleanupError) }) }
      try { ctx.backend.taskManager.clearCurrentUser() }
      catch (cleanupError) { log.warn('login scope cleanup failed', { cause: describeError(cleanupError) }) }
      throw error instanceof LoginFeedbackError || error instanceof AuthApiError ? error : new LoginFeedbackError('unknown', error)
    }
  }, { invalidMessage: '登录请求参数不合法', errorShape: 'auth' }),

  route(INVOKE_CHANNELS.AUTH_LIST_REMEMBERED_ACCOUNTS, NO_INPUT, (): RememberedAccountsResult => {
    try {
      return { accounts: listRememberedAccounts(), encryptionAvailable: safeStorage.isEncryptionAvailable() }
    } catch (error) {
      const failure = reportAuthFailure('list remembered accounts', error instanceof LoginFeedbackError ? error : new LoginFeedbackError('accounts_read', error))
      return { accounts: [], encryptionAvailable: safeStorage.isEncryptionAvailable(), error: failure.error }
    }
  }, { errorShape: 'auth' }),

  // 非邮箱一律当"没有保存的密码"，与原 handler 的 normalizeEmail 行为一致：
  // 这个通道是登录页填充用的，不该因为一个脏值把 invoke 打成 reject。
  route(INVOKE_CHANNELS.AUTH_GET_REMEMBERED_PASSWORD, email.catch(''), (_ctx, value): PasswordAvailabilityResult => {
    try { return { passwordAvailable: value ? Boolean(getRememberedPassword(value)) : false } }
    catch (error) {
      return { passwordAvailable: false, error: reportAuthFailure('check saved password', error instanceof LoginFeedbackError ? error : new LoginFeedbackError('password_read', error)).error }
    }
  }, { errorShape: 'auth' }),

  // Explicit reveal only. Account enumeration still exposes metadata, never credentials.
  route(INVOKE_CHANNELS.AUTH_REVEAL_REMEMBERED_PASSWORD, email, (_ctx, value): RememberedPasswordResult => {
    try { return { password: getRememberedPassword(value) } }
    catch (error) {
      return { password: null, error: reportAuthFailure('reveal saved password', error instanceof LoginFeedbackError ? error : new LoginFeedbackError('password_read', error)).error }
    }
  }, { errorShape: 'auth' }),

  route(INVOKE_CHANNELS.AUTH_FORGET_ACCOUNT, email, (_ctx, value): ForgetAccountResult => {
    try { forgetRememberedAccount(value) }
    catch (error) { throw new LoginFeedbackError('account_remove', error) }
    return { success: true, data: null }
  }, { invalidMessage: '请输入有效的邮箱地址', errorShape: 'auth' }),

  route(INVOKE_CHANNELS.AUTH_LOGOUT, NO_INPUT, async (ctx): Promise<LogoutResult> => {
    try { await ctx.backend.signOut() }
    catch (error) { throw new LoginFeedbackError('logout', error) }
    return { success: true, data: null }
  }, { errorShape: 'auth' }),

  route(INVOKE_CHANNELS.AUTH_GET_INSTANCES, NO_INPUT, async ctx => {
    const revision = ctx.backend.authSession.getSessionRevision()
    try {
      return { success: true, data: await ctx.employees.refresh() }
    } catch (error) {
      // 401 必须触发失效清理，否则用户停在一个令牌已作废的界面上。
      // 403 不算——那是权限不足，重新登录也不会变。
      if (
        revision === ctx.backend.authSession.getSessionRevision() &&
        (error instanceof AuthenticationRequiredError || (error instanceof AuthApiError && error.isUnauthorized))
      ) {
        ctx.backend.invalidateAuthentication()
      }
      throw error
    }
  }),

  route(INVOKE_CHANNELS.AUTH_GET_ORGANIZATION, NO_INPUT, async ctx => {
    const revision = ctx.backend.authSession.getSessionRevision()
    try {
      const accessToken = await ctx.backend.authSession.getValidAccessToken()
      return { success: true, data: await getEnterpriseOrganization(accessToken) }
    } catch (error) {
      if (revision === ctx.backend.authSession.getSessionRevision() &&
        (error instanceof AuthenticationRequiredError || (error instanceof AuthApiError && error.isUnauthorized))) {
        ctx.backend.invalidateAuthentication()
      }
      throw error
    }
  }),

  route(INVOKE_CHANNELS.AUTH_GET_EMPLOYEE_STATUS, NO_INPUT, async ctx => {
    const revision = ctx.backend.authSession.getSessionRevision()
    try {
      const accessToken = await ctx.backend.authSession.getValidAccessToken()
      return { success: true, data: await getEmployeeStatus(accessToken) }
    } catch (error) {
      if (revision === ctx.backend.authSession.getSessionRevision() &&
        (error instanceof AuthenticationRequiredError || (error instanceof AuthApiError && error.isUnauthorized))) {
        ctx.backend.invalidateAuthentication()
      }
      throw error
    }
  }),

  route(INVOKE_CHANNELS.SUBSCRIPTION_GET_SKILLS, z.string().trim().min(1).max(256), async (ctx, employeeId) => {
    const revision = ctx.backend.authSession.getSessionRevision()
    try {
      const accessToken = await ctx.backend.authSession.getValidAccessToken()
      return { success: true, data: await getEmployeeSkills(employeeId, accessToken) }
    } catch (error) {
      if (revision === ctx.backend.authSession.getSessionRevision() &&
        (error instanceof AuthenticationRequiredError || (error instanceof AuthApiError && error.isUnauthorized))) {
        ctx.backend.invalidateAuthentication()
      }
      throw error
    }
  }),

  route(INVOKE_CHANNELS.SUBSCRIPTION_PREVIEW_SKILL, z.string().trim().min(1).max(256), async (ctx, versionId) => {
    const revision = ctx.backend.authSession.getSessionRevision()
    try {
      const accessToken = await ctx.backend.authSession.getValidAccessToken()
      return { success: true, data: await previewSkill(versionId, accessToken) }
    } catch (error) {
      if (revision === ctx.backend.authSession.getSessionRevision() &&
        (error instanceof AuthenticationRequiredError || (error instanceof AuthApiError && error.isUnauthorized))) {
        ctx.backend.invalidateAuthentication()
      }
      throw error
    }
  }),
]
