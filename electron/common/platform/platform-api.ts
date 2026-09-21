import { config } from '../config'
import {
  enterpriseOrganizationSchema, enterpriseOverviewSchema, skillVersionSchema,
  personalSkillVersionRequestSchema, idempotencyKeySchema, skillVersionQuerySchema,
  skillVersionReviewQuerySchema, skillVersionReviewRequestSchema, skillVersionIdSchema,
  skillVersionListSchema, skillVersionReviewPageSchema,
} from '../../../src/shared/platform-supplement-contracts'
import type {
  EnterpriseOrganization, EnterpriseOverview, SkillVersion, PersonalSkillVersionRequest,
  SkillVersionQuery, SkillVersionReviewQuery, SkillVersionReviewRequest, SkillVersionReviewPage,
} from '../../../src/shared/platform-supplement-contracts'
export type {
  EnterpriseOrganization, EnterpriseOverview, SkillVersion, PersonalSkillVersionRequest,
  SkillVersionQuery, SkillVersionReviewQuery, SkillVersionReviewRequest, SkillVersionReviewPage,
} from '../../../src/shared/platform-supplement-contracts'
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

export interface ConversationMessageUpload {
  subscriptionId: string
  role: 'user' | 'assistant'
  content: string
  runId: string
  turnId: string
  modelId: string
  createdAt: string
}

export interface ConversationMessageUploadResponse {
  data: {
    conversationId: string
    messageId: string
    clientConversationId: string
    clientMessageId: string
    duplicate: boolean
    storedAt?: string
  }
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
  | 'conversations'
  | 'tasks'

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

async function putJson<T>(
  path: string, body: unknown, accessToken: string, resource: AuthApiResource,
): Promise<T> {
  const response = await fetch(`${config.SEP_BASE_URL}${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await parseError(response, resource)
  return response.json() as Promise<T>
}

export async function patchJson<T>(
  path: string, body: unknown, accessToken: string, resource: AuthApiResource,
): Promise<T> {
  const response = await fetch(`${config.SEP_BASE_URL}${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await parseError(response, resource)
  return response.json() as Promise<T>
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

export function getSubscriptions(accessToken: string): Promise<Subscription[]> {
  return getJson<Subscription[]>('/client/subscriptions', accessToken, 'subscriptions')
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


/** Enterprise scope is resolved by SEP from the access token, never from caller input. */
export async function getEnterpriseOrganization(accessToken: string): Promise<EnterpriseOrganization> {
  return enterpriseOrganizationSchema.parse(await getJson('/enterprise/organization', accessToken, 'organization'))
}

export async function getEnterpriseOverview(accessToken: string): Promise<EnterpriseOverview> {
  return enterpriseOverviewSchema.parse(await getJson('/enterprise/overview', accessToken, 'overview'))
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


export function saveEmployeeConversationMessage(
  clientConversationId: string,
  clientMessageId: string,
  request: ConversationMessageUpload,
  accessToken: string,
): Promise<ConversationMessageUploadResponse> {
  return putJson<ConversationMessageUploadResponse>(
    `/client/employee-conversations/${encodeURIComponent(clientConversationId)}/messages/${encodeURIComponent(clientMessageId)}`,
    request,
    accessToken,
    'conversations',
  )
}
