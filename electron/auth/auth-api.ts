/** Electron 主进程使用的 SEP 认证和订阅接口。 */

import { config } from '../infrastructure/config';
import type { EmployeeInstanceSnapshot } from '../../src/shared/types';

export interface LoginRequest {
  email: string;
  password: string;
  fingerprint: string;
  platform: string;
  clientVersion?: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
  user: { id: string; email: string; name: string };
  enterprise: { id: string; name: string } | null;
}

export interface RefreshResponse {
  accessToken: string;
  accessTokenExpiresIn: number;
  user: { id: string; email: string; name: string };
  enterprise: { id: string; name: string } | null;
}

export type ClientInstance = EmployeeInstanceSnapshot;

export interface InstanceTokenRequest {
  refreshToken: string;
  subscriptionId: string;
}

export interface InstanceTokenResponse {
  employmentToken: string;
  expiresIn: number;
  employment: { id: string; name: string; templateId: string; status: string };
}

export interface PackageInfo {
  version: string;
  packageRef: { type: 'npm' | 'git' | 'zip'; spec: string } | null;
  zipAvailable: boolean;
  sha256: string | null;
}

export interface EmployeeSkill {
  id: string;
  name: string;
  currentVersion: string;
  status: string;
  versionId?: string;
  content?: string;
}

export interface ApiError {
  statusCode: number;
  message: string;
  error: string;
}

async function parseError(response: Response, resource?: AuthApiResource): Promise<AuthApiError> {
  let error: ApiError;
  try {
    error = await response.json() as ApiError;
  } catch {
    error = { statusCode: response.status, message: response.statusText, error: 'Unknown Error' };
  }
  return new AuthApiError(error, resource);
}

export async function login(req: LoginRequest): Promise<LoginResponse> {
  const response = await fetch(`${config.SEP_API_BASE_URL}/client/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!response.ok) throw await parseError(response);
  return response.json() as Promise<LoginResponse>;
}

export async function refreshAccessToken(refreshToken: string): Promise<RefreshResponse> {
  const response = await fetch(`${config.SEP_API_BASE_URL}/client/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!response.ok) throw await parseError(response);
  return response.json() as Promise<RefreshResponse>;
}

interface SubscriptionPayload {
  id: unknown;
  subscriptionId: unknown;
  employeeId: unknown;
  name: unknown;
  status: unknown;
  templateVersion: unknown;
  template: unknown;
  allowedModels: unknown;
  department: unknown;
}

function normalizeSubscription(value: unknown): ClientInstance {
  const item = (value && typeof value === 'object' ? value : {}) as SubscriptionPayload;
  const id = typeof item.subscriptionId === 'string'
    ? item.subscriptionId
    : typeof item.id === 'string' ? item.id : '';
  const name = typeof item.name === 'string' ? item.name : id;
  const template = item.template && typeof item.template === 'object' ? item.template as Record<string, unknown> : {};
  const department = item.department && typeof item.department === 'object' ? item.department as Record<string, unknown> : null;
  return {
    id,
    name,
    status: item.status === 'ACTIVE' ? 'ACTIVE' : item.status === 'REVOKED' ? 'REVOKED' : 'PAUSED',
    templateVersion: typeof item.templateVersion === 'string' ? item.templateVersion : '',
    template: {
      id: typeof item.employeeId === 'string' ? item.employeeId : typeof template.id === 'string' ? template.id : '',
      name: typeof template.name === 'string' ? template.name : name,
      avatar: typeof template.avatar === 'string' ? template.avatar : null,
    },
    department: department && typeof department.id === 'string' && typeof department.name === 'string'
      ? { id: department.id, name: department.name }
      : null,
    // 旧版本地 SEP 可能不会在 /client/instances 中返回 allowedModels。
    // 使用配置中的默认模型保持订阅可运行，最终授权仍由雇佣网关判断。
    allowedModels: Array.isArray(item.allowedModels)
      ? item.allowedModels.filter((model): model is string => typeof model === 'string' && model.trim().length > 0)
      : [config.SEP_DEFAULT_MODEL],
  };
}

/** 获取当前成员处于 ACTIVE 状态的员工订阅。 */
export async function getInstances(accessToken: string): Promise<ClientInstance[]> {
  const headers = { 'Authorization': `Bearer ${accessToken}` };
  let response = await fetch(`${config.SEP_API_BASE_URL}/client/subscriptions`, { headers });
  if (response.status === 404) {
    response = await fetch(`${config.SEP_API_BASE_URL}/client/instances`, { headers });
  }
  if (!response.ok) throw await parseError(response);
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) throw new AuthApiError({ statusCode: 502, message: 'Invalid subscription response.', error: 'Bad Gateway' });
  return payload.map(normalizeSubscription);
}

/** 使用客户端刷新令牌换取订阅范围的雇佣令牌。 */
export async function getInstanceToken(req: InstanceTokenRequest, signal?: AbortSignal): Promise<InstanceTokenResponse> {
  const response = await fetch(`${config.SEP_API_BASE_URL}/client/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (!response.ok) throw await parseError(response);
  return response.json() as Promise<InstanceTokenResponse>;
}

type AuthApiResource = 'package' | 'subscriptions' | 'instance-token' | 'skills' | 'refresh' | 'login';

async function getJson<T>(path: string, accessToken: string, resource?: AuthApiResource): Promise<T> {
  const response = await fetch(`${config.SEP_API_BASE_URL}${path}`, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  if (!response.ok) throw await parseError(response, resource);
  return response.json() as Promise<T>;
}

export function getPackageInfo(subscriptionId: string, accessToken: string): Promise<PackageInfo> {
  return getJson<unknown>(`/enterprise/subscriptions/${encodeURIComponent(subscriptionId)}/package`, accessToken, 'package').then(payload => {
    if (!payload || typeof payload !== 'object') throw new AuthApiError({ statusCode: 502, message: 'Invalid package response.', error: 'Bad Gateway' })
    const value = payload as Record<string, unknown>
    const ref = value.packageRef && typeof value.packageRef === 'object' ? value.packageRef as Record<string, unknown> : null
    const type = ref?.type
    if (typeof value.version !== 'string' || (ref && (type !== 'npm' && type !== 'git' && type !== 'zip')) || (ref && typeof ref.spec !== 'string')) {
      throw new AuthApiError({ statusCode: 502, message: 'Invalid package response.', error: 'Bad Gateway' })
    }
    return { version: value.version, packageRef: ref ? { type: type as 'npm' | 'git' | 'zip', spec: ref.spec as string } : null, zipAvailable: value.zipAvailable === true, sha256: typeof value.sha256 === 'string' ? value.sha256 : null }
  });
}

export async function getEmployeeSkills(employeeId: string, accessToken: string): Promise<EmployeeSkill[]> {
  const payload = await getJson<unknown>(`/enterprise/employees/${encodeURIComponent(employeeId)}/skills`, accessToken)
  const values = Array.isArray(payload) ? payload : payload && typeof payload === 'object' && Array.isArray((payload as { skills?: unknown }).skills) ? (payload as { skills: unknown[] }).skills : []
  return values.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const item = value as Record<string, unknown>
    const version = item.currentVersion && typeof item.currentVersion === 'object' ? item.currentVersion as Record<string, unknown> : null
    // v1 会同时返回能力元数据和选中的当前版本。
    // 对旧版平台响应保留扁平字段兼容处理。
    const capability = item.capability && typeof item.capability === 'object' ? item.capability as Record<string, unknown> : null
    const id = typeof capability?.id === 'string'
      ? capability.id
      : typeof item.id === 'string' ? item.id : typeof item.skillId === 'string' ? item.skillId : ''
    const currentVersion = typeof item.currentVersion === 'string' ? item.currentVersion : typeof version?.version === 'string' ? version.version : ''
    const status = typeof version?.status === 'string' ? version.status : typeof item.status === 'string' ? item.status : ''
    if (!id || !currentVersion) return []
    return [{
      id,
      name: typeof capability?.name === 'string' ? capability.name : typeof item.name === 'string' ? item.name : id,
      currentVersion,
      status,
      versionId: typeof version?.id === 'string' ? version.id : typeof item.versionId === 'string' ? item.versionId : undefined,
      content: typeof version?.content === 'string' ? version.content : typeof item.content === 'string' ? item.content : undefined,
    }]
  })
}

export class AuthApiError extends Error {
  constructor(public readonly error: ApiError, public readonly resource?: AuthApiResource) {
    super(error.message);
    this.name = 'AuthApiError';
  }
  get statusCode(): number { return this.error.statusCode; }
  get isUnauthorized(): boolean { return this.error.statusCode === 401; }
  get isForbidden(): boolean { return this.error.statusCode === 403; }
  get isNetworkError(): boolean { return this.error.statusCode === 0 || this.error.statusCode >= 500; }
}
