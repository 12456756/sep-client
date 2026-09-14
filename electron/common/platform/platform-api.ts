import { config } from '../config'
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

export interface PackageInfo {
  version: string
  packageRef: {
    type: 'npm' | 'git' | 'zip'
    spec: string
  } | null
  zipAvailable: boolean
  sha256: string | null
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
  versions: unknown[]
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
  | 'package'
  | 'subscriptions'
  | 'employment-token'
  | 'skills'
  | 'knowledge'
  | 'refresh'
  | 'login'
  | 'notifications'
  | 'upload'

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

async function postJson<T>(path: string, body: unknown, accessToken: string, resource: AuthApiResource): Promise<T> {
  const response = await fetch(`${config.SEP_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
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

export function getPackageInfo(subscriptionId: string, accessToken: string): Promise<PackageInfo> {
  return getJson<PackageInfo>(
    `/enterprise/subscriptions/${encodeURIComponent(subscriptionId)}/package`,
    accessToken,
    'package',
  )
}

export async function downloadPackage(
  subscriptionId: string,
  accessToken: string,
): Promise<{ bytes: Uint8Array; sha256: string; version: string }> {
  const response = await fetch(
    `${config.SEP_BASE_URL}/enterprise/subscriptions/${encodeURIComponent(subscriptionId)}/package/download`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!response.ok) throw await parseError(response, 'package')
  const sha256 = response.headers.get('X-SHA256')
  const version = response.headers.get('X-Version')
  if (!sha256 || !version) {
    throw new AuthApiError({ statusCode: 502, message: 'Invalid package download response.' }, 'package')
  }
  return { bytes: new Uint8Array(await response.arrayBuffer()), sha256, version }
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
