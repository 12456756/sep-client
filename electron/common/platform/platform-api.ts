import { config } from '../config'
import {
  enterpriseOrganizationSchema, enterpriseOverviewSchema, platformEmployeePageSchema, employeeAccessRequestSchema, employeeAccessRequestInputSchema, skillVersionSchema,
  personalSkillVersionRequestSchema, idempotencyKeySchema, skillVersionQuerySchema,
  skillVersionReviewQuerySchema, skillVersionReviewRequestSchema, skillVersionIdSchema,
  skillVersionListSchema, skillVersionReviewPageSchema,
} from '../../../src/shared/platform-supplement-contracts'
import {
  computeAllowanceSchema, personalWalletSchema, walletTransactionsPageSchema,
  computeUsageRecordsPageSchema, computeUsageBreakdownSchema,
  computePageQuerySchema, computeUsageQuerySchema, computeBreakdownDaysSchema,
} from '../../../src/shared/compute-credit-contracts'
import {
  clientProfileSchema, enterpriseLogoUploadResponseSchema, personalRechargeOrderSchema,
  personalRechargeQuerySchema, personalRechargeReconcileSchema, personalRechargeRequestSchema,
  personalRechargeStatusResponseSchema,
  userAvatarUploadResponseSchema,
} from '../../../src/shared/profile-wallet-contracts'
import type {
  ComputeAllowance, PersonalWallet, WalletTransactionsPage, ComputeUsageRecordsPage,
  ComputeUsageBreakdown, ComputePageQuery, ComputeUsageQuery,
} from '../../../src/shared/compute-credit-contracts'
import type {
  EnterpriseOrganization, EnterpriseOverview, PlatformEmployeePage, EmployeeAccessRequest, EmployeeAccessRequestInput, SkillVersion, PersonalSkillVersionRequest,
  SkillVersionQuery, SkillVersionReviewQuery, SkillVersionReviewRequest, SkillVersionReviewPage,
} from '../../../src/shared/platform-supplement-contracts'
import type {
  ClientProfile, EnterpriseLogoUploadResponse, PersonalRechargeOrder, PersonalRechargeReconcileResult,
  PersonalRechargeRequest, PersonalRechargeStatusResponse, UserAvatarUploadResponse,
} from '../../../src/shared/profile-wallet-contracts'
export type {
  EnterpriseOrganization, EnterpriseOverview, PlatformEmployeePage, EmployeeAccessRequest, EmployeeAccessRequestInput, SkillVersion, PersonalSkillVersionRequest,
  SkillVersionQuery, SkillVersionReviewQuery, SkillVersionReviewRequest, SkillVersionReviewPage,
} from '../../../src/shared/platform-supplement-contracts'
export type {
  ClientProfile, EnterpriseLogoUploadResponse, PersonalRechargeOrder, PersonalRechargeReconcileResult,
  PersonalRechargeRequest, PersonalRechargeStatusResponse, UserAvatarUploadResponse,
} from '../../../src/shared/profile-wallet-contracts'
import type { Subscription } from '../../../src/shared/types'

export type { Subscription } from '../../../src/shared/types'

export type SubscriptionStatus = 'ACTIVE' | 'PAUSED' | 'REVOKED'

export interface PlatformUser {
  id: string
  email: string
  name: string
  role: string
}

export interface PlatformEnterprise {
  id: string
  name: string
}

export interface PlatformDevice {
  id: string
  fingerprint: string
  platform: string
  lastSeenAt: string
}

export interface LoginRequest {
  email: string
  password: string
  fingerprint: string
  platform: string
  clientVersion?: string
}

export interface LoginResponse {
  accessToken: string
  refreshToken: string
  accessTokenExpiresIn: number
  refreshTokenExpiresIn: number
  user: PlatformUser
  enterprise: PlatformEnterprise | null
  devices: PlatformDevice[]
}

export interface RefreshResponse {
  accessToken: string
  refreshToken: string
  accessTokenExpiresIn: number
  user: PlatformUser
  enterprise: PlatformEnterprise | null
}

export interface EmploymentTokenRequest {
  refreshToken: string
  subscriptionId: string
}

export interface EmploymentTokenResponse {
  employmentToken: string
  refreshToken: string
  expiresIn: number
  employment: {
    id: string
    name: string
    templateId: string
    status: SubscriptionStatus
  }
}

export interface EmployeeSkill {
  capability: {
    id: string
    name: string
    description: string
    type: string
  }
  currentVersion: {
    id: string
    capabilityId: string
    scope: string
    enterpriseId: string | null
    version: string
    changeSummary: string
    status: string
    createdAt: string
    updatedAt: string
  }
  latestPublishedVersion?: SkillVersion | null
  versions: SkillVersion[]
  upgradeAvailable: boolean
}

export interface EmployeeSkillsResponse {
  subscriptionId: string
  canManage: boolean
  skills: EmployeeSkill[]
}

export interface SkillPreviewResponse {
  content: string
  [key: string]: unknown
}

export interface KnowledgeBaseGrant {
  id: string
  knowledgeBase: {
    id: string
    name: string
  }
}

export interface KnowledgeBaseGrantsResponse {
  grants: KnowledgeBaseGrant[]
}

export type KnowledgeSearchStrategy = 'auto' | 'lexical' | 'vector' | 'hybrid'

export interface KnowledgeBaseSearchRequest {
  query: string
  subscriptionId: string
  topK?: number
  scoreThreshold?: number
  strategy?: KnowledgeSearchStrategy
}

export interface KnowledgeBaseSearchResult {
  chunkId: string
  knowledgeBaseId: string
  source: string
  score: number
  content: string
}

export interface KnowledgeBaseSearchResponse {
  query: string
  subscriptionId: string
  strategy: KnowledgeSearchStrategy
  durationMs: number
  count: number
  results: KnowledgeBaseSearchResult[]
}

export interface Notification {
  id: string
  category: string
  [key: string]: unknown
}

export interface EmployeeStatus {
  employeeId: string
  status: string
}

export interface UploadFile {
  key: string
  url?: string
  [key: string]: unknown
}

export interface UploadInput {
  bytes: Uint8Array
  filename: string
  contentType: string
}

export interface NotificationQuery {
  limit?: number
  offset?: number
  category?: string
  unreadOnly?: boolean
}

export interface ApiError {
  statusCode: number
  message: string
  requestId?: string
  timestamp?: string
  path?: string
}

type AuthApiResource =
  | 'subscriptions'
  | 'employment-token'
  | 'skills'
  | 'knowledge'
  | 'refresh'
  | 'login'
  | 'notifications'
  | 'upload'
  | 'organization'
  | 'overview'
  | 'compute-credit'
  | 'personal-wallet'
  | 'profile'
  | 'employee-directory'
  | 'employee-access-requests'

export class AuthApiError extends Error {
  constructor(
    public readonly error: ApiError,
    public readonly resource?: AuthApiResource,
  ) {
    super(error.message)
    this.name = 'AuthApiError'
  }

  get statusCode(): number {
    return this.error.statusCode
  }

  get isUnauthorized(): boolean {
    return this.error.statusCode === 401
  }

  get isForbidden(): boolean {
    return this.error.statusCode === 403
  }

  get isNetworkError(): boolean {
    return this.error.statusCode === 0 || this.error.statusCode >= 500
  }
}

async function parseError(response: Response, resource?: AuthApiResource): Promise<AuthApiError> {
  try {
    const value = await response.json() as Partial<ApiError>
    return new AuthApiError({
      statusCode: typeof value.statusCode === 'number' ? value.statusCode : response.status,
      message: typeof value.message === 'string' ? value.message : response.statusText,
      requestId: value.requestId,
      timestamp: value.timestamp,
      path: value.path,
    }, resource)
  } catch {
    return new AuthApiError({ statusCode: response.status, message: response.statusText }, resource)
  }
}

async function getJson<T>(path: string, accessToken: string, resource: AuthApiResource): Promise<T> {
  const response = await fetch(`${config.SEP_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) throw await parseError(response, resource)
  return response.json() as Promise<T>
}

async function postJson<T>(
  path: string, body: unknown, accessToken: string, resource: AuthApiResource,
  idempotencyKey?: string,
): Promise<T> {
  const response = await fetch(`${config.SEP_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await parseError(response, resource)
  return response.json() as Promise<T>
}

async function postMultipart<T>(
  path: string, input: UploadInput, accessToken: string, resource: AuthApiResource,
): Promise<T> {
  const form = new FormData()
  form.append('file', new Blob([input.bytes], { type: input.contentType }), input.filename)
  const response = await fetch(`${config.SEP_BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  })
  if (!response.ok) throw await parseError(response, resource)
  return response.json() as Promise<T>
}

function validateImageInput(input: UploadInput): UploadInput {
  const maxBytes = 2 * 1024 * 1024
  const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
  const extensions: Record<string, string[]> = {
    'image/png': ['.png'],
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/webp': ['.webp'],
  }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0 || input.bytes.byteLength > maxBytes) {
    throw new Error('图片大小必须大于 0 且不超过 2 MB')
  }
  if (!allowedTypes.has(input.contentType)) throw new Error('仅支持 PNG、JPEG 或 WebP 图片')
  if (input.filename !== input.filename.split(/[\\/]/).pop()) throw new Error('图片文件名无效')
  const extension = input.filename.slice(input.filename.lastIndexOf('.')).toLowerCase()
  if (!extensions[input.contentType]?.includes(extension)) throw new Error('图片扩展名与 MIME 类型不匹配')
  return input
}

export async function login(request: LoginRequest): Promise<LoginResponse> {
  const response = await fetch(`${config.SEP_BASE_URL}/client/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw await parseError(response, 'login')
  return response.json() as Promise<LoginResponse>
}

export async function refreshAccessToken(refreshToken: string): Promise<RefreshResponse> {
  const response = await fetch(`${config.SEP_BASE_URL}/client/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
  if (!response.ok) throw await parseError(response, 'refresh')
  return response.json() as Promise<RefreshResponse>
}

export async function getSubscriptions(accessToken: string): Promise<Subscription[]> {
  const data = await getJson<Subscription[]>('/client/subscriptions', accessToken, 'subscriptions')
  return normalizeSubscriptions(data)
}

export async function getEmploymentToken(
  request: EmploymentTokenRequest,
  signal?: AbortSignal,
): Promise<EmploymentTokenResponse> {
  const response = await fetch(`${config.SEP_BASE_URL}/client/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  if (!response.ok) throw await parseError(response, 'employment-token')
  return response.json() as Promise<EmploymentTokenResponse>
}

export function getEmployeeSkills(
  employeeId: string,
  accessToken: string,
): Promise<EmployeeSkillsResponse> {
  return getJson<EmployeeSkillsResponse>(
    `/enterprise/employees/${encodeURIComponent(employeeId)}/skills`,
    accessToken,
    'skills',
  )
}

export function previewSkill(versionId: string, accessToken: string): Promise<SkillPreviewResponse> {
  return getJson<SkillPreviewResponse>(
    `/enterprise/skill-versions/${encodeURIComponent(versionId)}/preview`,
    accessToken,
    'skills',
  )
}

export function getKnowledgeBaseGrants(
  subscriptionId: string,
  accessToken: string,
): Promise<KnowledgeBaseGrantsResponse> {
  return getJson<KnowledgeBaseGrantsResponse>(
    `/knowledge-bases/grants/by-subscription/${encodeURIComponent(subscriptionId)}`,
    accessToken,
    'knowledge',
  )
}

export function searchKnowledgeBases(
  request: KnowledgeBaseSearchRequest,
  accessToken: string,
): Promise<KnowledgeBaseSearchResponse> {
  return postJson<KnowledgeBaseSearchResponse>('/knowledge-bases/search', request, accessToken, 'knowledge')
}

export function getEmployeeStatus(accessToken: string): Promise<EmployeeStatus[]> {
  return getJson<EmployeeStatus[]>('/enterprise/employee-status', accessToken, 'subscriptions')
}

export function listNotifications(accessToken: string, params: NotificationQuery = {}): Promise<Notification[]> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value))
  }
  return getJson<Notification[]>(`/notifications${query.size ? `?${query.toString()}` : ''}`, accessToken, 'notifications')
}

export function getUnreadNotificationCount(accessToken: string): Promise<{ count: number }> {
  return getJson<{ count: number }>('/notifications/unread-count', accessToken, 'notifications')
}

export function markNotificationRead(notificationId: string, accessToken: string): Promise<unknown> {
  return postJson('/notifications/' + encodeURIComponent(notificationId) + '/read', {}, accessToken, 'notifications')
}

export function markAllNotificationsRead(accessToken: string): Promise<unknown> {
  return postJson('/notifications/read-all', {}, accessToken, 'notifications')
}

export function deleteNotification(notificationId: string, accessToken: string): Promise<unknown> {
  return deleteJson('/notifications/' + encodeURIComponent(notificationId), accessToken, 'notifications')
}

export function clearReadNotifications(accessToken: string): Promise<unknown> {
  return deleteJson('/notifications/clear-read', accessToken, 'notifications')
}

export async function uploadFile(input: UploadInput, accessToken: string): Promise<UploadFile> {
  const form = new FormData()
  form.append('file', new Blob([input.bytes], { type: input.contentType }), input.filename)
  const response = await fetch(`${config.SEP_BASE_URL}/upload/file`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  })
  if (!response.ok) throw await parseError(response, 'upload')
  return response.json() as Promise<UploadFile>
}

export async function uploadFiles(inputs: UploadInput[], accessToken: string): Promise<UploadFile[]> {
  const form = new FormData()
  for (const input of inputs) {
    form.append('files', new Blob([input.bytes], { type: input.contentType }), input.filename)
  }
  const response = await fetch(`${config.SEP_BASE_URL}/upload/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  })
  if (!response.ok) throw await parseError(response, 'upload')
  return response.json() as Promise<UploadFile[]>
}

export async function refreshUploadUrl(key: string, accessToken: string): Promise<UploadFile> {
  return postJson<UploadFile>(`/upload/refresh-url?key=${encodeURIComponent(key)}`, {}, accessToken, 'upload')
}

async function deleteJson<T>(path: string, accessToken: string, resource: AuthApiResource): Promise<T> {
  const response = await fetch(`${config.SEP_BASE_URL}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) throw await parseError(response, resource)
  return response.json() as Promise<T>
}


/**
 * Web pages resolve root-relative image paths against their own origin. The Electron
 * renderer is loaded from file://, so resolve platform-provided asset paths here,
 * before the data crosses the IPC boundary. The platform currently stores user and
 * enterprise images as paths such as /api/users/avatars/... and /api/enterprise/logos/....
 */
export function resolvePlatformAssetUrl(value: string | null | undefined): string | null | undefined {
  if (value == null || value.length === 0) return value
  try {
    const baseUrl = value.startsWith('/assets/') ? config.SEP_ASSET_BASE_URL : config.SEP_BASE_URL
    const resolved = new URL(value, baseUrl)
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return value
    return resolved.href
  } catch {
    return value
  }
}

type PlatformAvatarAsset = NonNullable<EnterpriseOverview['employees'][number]['avatarAsset']>
type PlatformSubscriptionAvatarAsset = NonNullable<Subscription['template']['avatarAsset']>

function normalizeAvatarAsset<T extends PlatformAvatarAsset | PlatformSubscriptionAvatarAsset>(asset: T | null | undefined): T | null | undefined {
  if (asset == null) return asset
  return {
    ...asset,
    portraitUrl: resolvePlatformAssetUrl(asset.portraitUrl) ?? asset.portraitUrl,
    faceUrl: resolvePlatformAssetUrl(asset.faceUrl) ?? asset.faceUrl,
  }
}

function normalizeEnterpriseOrganization(data: EnterpriseOrganization): EnterpriseOrganization {
  return {
    ...data,
    enterprise: {
      ...data.enterprise,
      logo: resolvePlatformAssetUrl(data.enterprise.logo) ?? null,
    },
    employees: data.employees.map(employee => ({
      ...employee,
      avatar: resolvePlatformAssetUrl(employee.avatar) ?? null,
      ...(employee.avatarAsset === undefined ? {} : { avatarAsset: normalizeAvatarAsset(employee.avatarAsset) }),
    })),
    members: data.members.map(member => ({
      ...member,
      avatar: resolvePlatformAssetUrl(member.avatar) ?? null,
      ...(member.avatarAsset === undefined ? {} : { avatarAsset: normalizeAvatarAsset(member.avatarAsset) }),
    })),
  }
}

function normalizeEnterpriseOverview(data: EnterpriseOverview): EnterpriseOverview {
  return {
    ...data,
    enterprise: {
      ...data.enterprise,
      logo: resolvePlatformAssetUrl(data.enterprise.logo) ?? null,
    },
    employees: data.employees.map(employee => ({
      ...employee,
      avatar: resolvePlatformAssetUrl(employee.avatar) ?? null,
      ...(employee.avatarAsset === undefined ? {} : { avatarAsset: normalizeAvatarAsset(employee.avatarAsset) }),
    })),
  }
}

function normalizeSubscriptions(data: Subscription[]): Subscription[] {
  return data.map(subscription => ({
    ...subscription,
    template: {
      ...subscription.template,
      avatar: resolvePlatformAssetUrl(subscription.template.avatar) ?? null,
      ...(subscription.template.avatarAsset === undefined
        ? {}
        : { avatarAsset: normalizeAvatarAsset(subscription.template.avatarAsset) }),
    },
  }))
}

/** Enterprise scope is resolved by SEP from the access token, never from caller input. */
export async function getEnterpriseOrganization(accessToken: string): Promise<EnterpriseOrganization> {
  const data = enterpriseOrganizationSchema.parse(await getJson('/enterprise/organization', accessToken, 'organization'))
  return normalizeEnterpriseOrganization(data)
}

export async function getPlatformEmployees(
  accessToken: string,
  params: { keyword?: string; capabilityId?: string; functionalCategory?: string; page?: number; pageSize?: number; sort?: 'updatedAt_desc' | 'createdAt_desc' | 'name_asc' } = {},
): Promise<PlatformEmployeePage> {
  const query = platformQuery(params)
  return platformEmployeePageSchema.parse(await getJson('/client/platform-employees' + query, accessToken, 'employee-directory'))
}

export async function createEmployeeAccessRequest(
  request: EmployeeAccessRequestInput,
  idempotencyKey: string,
  accessToken: string,
): Promise<EmployeeAccessRequest> {
  const body = employeeAccessRequestInputSchema.parse(request)
  const key = idempotencyKeySchema.parse(idempotencyKey)
  return employeeAccessRequestSchema.parse(await postJson('/client/employee-access-requests', body, accessToken, 'employee-access-requests', key))
}

export async function getEmployeeAccessRequest(requestId: string, accessToken: string): Promise<EmployeeAccessRequest> {
  return employeeAccessRequestSchema.parse(await getJson('/client/employee-access-requests/' + encodeURIComponent(requestId), accessToken, 'employee-access-requests'))
}

export async function getEnterpriseOverview(accessToken: string): Promise<EnterpriseOverview> {
  const data = enterpriseOverviewSchema.parse(await getJson('/enterprise/overview', accessToken, 'overview'))
  return normalizeEnterpriseOverview(data)
}

export async function getClientProfile(accessToken: string): Promise<ClientProfile> {
  return clientProfileSchema.parse(await getJson('/client/profile', accessToken, 'profile'))
}

export async function uploadUserAvatar(input: UploadInput, accessToken: string): Promise<UserAvatarUploadResponse> {
  return userAvatarUploadResponseSchema.parse(await postMultipart('/users/me/avatar', validateImageInput(input), accessToken, 'profile'))
}

export async function uploadEnterpriseLogo(input: UploadInput, accessToken: string): Promise<EnterpriseLogoUploadResponse> {
  return enterpriseLogoUploadResponseSchema.parse(await postMultipart('/enterprise/logo', validateImageInput(input), accessToken, 'profile'))
}

export async function createPersonalRecharge(
  request: PersonalRechargeRequest, accessToken: string,
): Promise<PersonalRechargeOrder> {
  const body = personalRechargeRequestSchema.parse(request)
  return personalRechargeOrderSchema.parse(await postJson('/personal-wallet/recharge', body, accessToken, 'personal-wallet'))
}

export async function getPersonalRecharge(orderNo: string, accessToken: string): Promise<PersonalRechargeStatusResponse> {
  const order = personalRechargeQuerySchema.parse(orderNo)
  return personalRechargeStatusResponseSchema.parse(await getJson(`/personal-wallet/recharge/${encodeURIComponent(order)}`, accessToken, 'personal-wallet'))
}

export async function reconcilePersonalRecharge(
  orderNo: string, accessToken: string,
): Promise<PersonalRechargeReconcileResult> {
  const order = personalRechargeQuerySchema.parse(orderNo)
  return personalRechargeReconcileSchema.parse(await postJson(`/personal-wallet/recharge/${encodeURIComponent(order)}/reconcile`, {}, accessToken, 'personal-wallet'))
}

export async function getMyComputeAllowance(accessToken: string): Promise<ComputeAllowance> {
  return computeAllowanceSchema.parse(await getJson('/compute-credit/my-allowance', accessToken, 'compute-credit'))
}

export async function getPersonalWallet(accessToken: string): Promise<PersonalWallet> {
  return personalWalletSchema.parse(await getJson('/personal-wallet', accessToken, 'personal-wallet'))
}

export async function getPersonalWalletTransactions(
  accessToken: string, params: ComputePageQuery,
): Promise<WalletTransactionsPage> {
  const query = platformQuery(computePageQuerySchema.parse(params))
  return walletTransactionsPageSchema.parse(
    await getJson('/personal-wallet/transactions' + query, accessToken, 'personal-wallet'),
  )
}

export async function getComputeUsageRecords(
  accessToken: string, params: ComputeUsageQuery,
): Promise<ComputeUsageRecordsPage> {
  const query = platformQuery(computeUsageQuerySchema.parse(params))
  return computeUsageRecordsPageSchema.parse(
    await getJson('/compute-credit/usage-records' + query, accessToken, 'compute-credit'),
  )
}

export async function getComputeUsageBreakdown(
  accessToken: string, days: number,
): Promise<ComputeUsageBreakdown> {
  const validDays = computeBreakdownDaysSchema.parse(days)
  const query = platformQuery({ days: validDays })
  return computeUsageBreakdownSchema.parse(
    await getJson('/compute-credit/usage-breakdown' + query, accessToken, 'compute-credit'),
  )
}

/** One save creates and submits a version. The caller must retain this key for retries. */
export async function createPersonalSkillVersion(
  request: PersonalSkillVersionRequest, idempotencyKey: string, accessToken: string,
): Promise<SkillVersion> {
  const body = personalSkillVersionRequestSchema.parse(request)
  const key = idempotencyKeySchema.parse(idempotencyKey)
  return skillVersionSchema.parse(await postJson('/enterprise/skill-versions', body, accessToken, 'skills', key))
}

function platformQuery(params: object): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value))
  }
  return query.size ? '?' + query.toString() : ''
}

/** capabilityId is required to avoid the legacy enterprise-only listing semantics. */
export async function listSkillVersions(params: SkillVersionQuery, accessToken: string): Promise<SkillVersion[]> {
  const query = platformQuery(skillVersionQuerySchema.parse(params))
  return skillVersionListSchema.parse(await getJson('/enterprise/skill-versions' + query, accessToken, 'skills'))
}

export async function listSkillVersionReviews(
  accessToken: string, params: SkillVersionReviewQuery = {},
): Promise<SkillVersionReviewPage> {
  const query = platformQuery(skillVersionReviewQuerySchema.parse(params))
  return skillVersionReviewPageSchema.parse(await getJson('/enterprise/skill-version-reviews' + query, accessToken, 'skills'))
}

/** Admin-only on SEP. Never retry a review automatically after a lost response. */
export async function reviewSkillVersion(
  versionId: string, request: SkillVersionReviewRequest, accessToken: string,
): Promise<SkillVersion> {
  const id = encodeURIComponent(skillVersionIdSchema.parse(versionId))
  const body = skillVersionReviewRequestSchema.parse(request)
  return skillVersionSchema.parse(await postJson('/enterprise/skill-versions/' + id + '/review', body, accessToken, 'skills'))
}
