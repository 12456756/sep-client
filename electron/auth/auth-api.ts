/**
 * SEP Authentication API
 *
 * Handles all authentication-related API calls to SEP backend.
 */

import { config } from '../infrastructure/config';
import type { SubscriptionSnapshot as SharedSubscriptionSnapshot, PackageRef } from '../../src/shared/types';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

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
  accessTokenExpiresIn?: number;
  refreshTokenExpiresIn?: number;
  /** Legacy server field. Prefer accessTokenExpiresIn. */
  expiresIn?: number;
  user: {
    id: string;
    email: string;
    name: string;
  };
  enterprise: {
    id: string;
    name: string;
  } | null;
}

export type SubscriptionSnapshot = SharedSubscriptionSnapshot;

export interface RefreshResponse {
  accessToken: string;
  accessTokenExpiresIn?: number;
  expiresIn?: number;
  refreshToken?: string;
  user: LoginResponse['user'];
  enterprise: NonNullable<LoginResponse['enterprise']>;
}

export interface EmploymentTokenRequest {
  refreshToken: string;
  subscriptionId: string;
}

export interface EmploymentTokenResponse {
  employmentToken: string;
  expiresIn: number;
  employment: {
    id: string;
    name: string;
    templateId: string;
    status: string;
  };
}

export interface PackageInfo {
  version: string;
  packageRef: PackageRef | null;
  zipAvailable: boolean;
  sha256: string | null;
}

export interface SkillVersionSummary {
  id: string;
  capabilityId: string;
  scope: string;
  enterpriseId: string | null;
  version: string;
  changeSummary: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeSkillSnapshot {
  capability: { id: string; name: string; description?: string | null; type?: string };
  currentVersion: SkillVersionSummary | null;
  versions: SkillVersionSummary[];
  upgradeAvailable: boolean;
}

export interface EmployeeSkillsResponse {
  subscriptionId: string;
  canManage: boolean;
  skills: EmployeeSkillSnapshot[];
}

export interface SkillPreviewResponse {
  id: string;
  version: SkillVersionSummary;
  capability: EmployeeSkillSnapshot['capability'];
  content: string;
}

export interface KnowledgeBaseGrant {
  id: string;
  knowledgeBase: { id: string; name: string };
}

export interface KnowledgeBaseGrantResponse {
  grants: KnowledgeBaseGrant[];
}

export interface KnowledgeBaseSearchRequest {
  query: string;
  subscriptionId: string;
  topK?: number;
  scoreThreshold?: number;
  strategy?: 'auto' | 'lexical' | 'vector' | 'hybrid';
}

export interface KnowledgeBaseSearchResult {
  chunkId: string;
  knowledgeBaseId: string;
  source: string;
  score: number;
  content: string;
}

export interface KnowledgeBaseSearchResponse {
  query: string;
  subscriptionId: string;
  strategy: string;
  durationMs: number;
  count: number;
  results: KnowledgeBaseSearchResult[];
}

export interface ApiError {
  statusCode: number;
  message: string;
  error: string;
}

// ─────────────────────────────────────────────────────────────────
// API Functions
// ─────────────────────────────────────────────────────────────────

/**
 * Login with email and password
 *
 * POST /client/auth/login
 */
export async function login(req: LoginRequest): Promise<LoginResponse> {
  const response = await fetch(`${config.SEP_BASE_URL}/client/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req),
  });

  if (!response.ok) {
    let error: ApiError;
    try {
      error = await response.json() as ApiError;
    } catch {
      error = {
        statusCode: response.status,
        message: response.statusText,
        error: 'Unknown Error',
      };
    }
    throw new AuthApiError(error);
  }

  return response.json() as Promise<LoginResponse>;
}

/** Refresh a normal access token without exposing it to the renderer. */
export async function refreshAccessToken(refreshToken: string): Promise<RefreshResponse> {
  const response = await fetch(`${config.SEP_BASE_URL}/client/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!response.ok) throw new AuthApiError(await readApiError(response));
  return response.json() as Promise<RefreshResponse>;
}

/**
 * Get the current member's authorized employee subscriptions.
 *
 * GET /client/instances
 */
export async function getSubscriptions(accessToken: string): Promise<SubscriptionSnapshot[]> {
  let response = await fetch(`${config.SEP_BASE_URL}/client/subscriptions`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  // The server migration keeps /client/instances for one compatibility window.
  if (response.status === 404) {
    response = await fetch(`${config.SEP_BASE_URL}/client/instances`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  if (!response.ok) {
    throw new AuthApiError(await readApiError(response));
  }

  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) throw new AuthApiError({ statusCode: 502, message: 'Invalid subscription response.', error: 'Bad Gateway' });
  return payload.map(normalizeSubscription).filter((item): item is SubscriptionSnapshot => item !== null);
}

/**
 * Exchange a refresh token for a subscription-scoped employment token.
 *
 * POST /client/auth/token
 */
export async function getEmploymentToken(req: EmploymentTokenRequest, signal?: AbortSignal): Promise<EmploymentTokenResponse> {
  const response = await fetch(`${config.SEP_BASE_URL}/client/auth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req),
    signal,
  });

  if (!response.ok) {
    throw new AuthApiError(await readApiError(response));
  }

  return response.json() as Promise<EmploymentTokenResponse>;
}

export async function getPackageInfo(accessToken: string, subscriptionId: string): Promise<PackageInfo> {
  return authorizedJson<PackageInfo>(`/enterprise/subscriptions/${encodeURIComponent(subscriptionId)}/package`, accessToken);
}

export async function getEmployeeSkills(accessToken: string, employeeId: string): Promise<EmployeeSkillsResponse> {
  return authorizedJson<EmployeeSkillsResponse>(`/enterprise/employees/${encodeURIComponent(employeeId)}/skills`, accessToken);
}

export async function getSkillPreview(accessToken: string, versionId: string): Promise<SkillPreviewResponse> {
  return authorizedJson<SkillPreviewResponse>(`/enterprise/skill-versions/${encodeURIComponent(versionId)}/preview`, accessToken);
}

export async function getKnowledgeBaseGrants(accessToken: string, subscriptionId: string): Promise<KnowledgeBaseGrantResponse> {
  return authorizedJson<KnowledgeBaseGrantResponse>(
    `/knowledge-bases/grants/by-subscription/${encodeURIComponent(subscriptionId)}`,
    accessToken,
  );
}

export async function searchKnowledgeBases(
  accessToken: string,
  request: KnowledgeBaseSearchRequest,
): Promise<KnowledgeBaseSearchResponse> {
  if (!request.query.trim() || !request.subscriptionId.trim()) {
    throw new AuthApiError({ statusCode: 400, message: 'A query and subscription ID are required.', error: 'Bad Request' });
  }
  const topK = Number.isFinite(request.topK)
    ? Math.max(1, Math.min(20, Math.floor(request.topK!)))
    : 5;
  const scoreThreshold = Number.isFinite(request.scoreThreshold)
    ? Math.max(0, Math.min(1, request.scoreThreshold!))
    : 0.5;
  const strategy = request.strategy === 'lexical' || request.strategy === 'vector' || request.strategy === 'hybrid'
    ? request.strategy
    : 'auto';
  const response = await fetch(`${config.SEP_BASE_URL}/knowledge-bases/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...request,
      query: request.query.trim(),
      subscriptionId: request.subscriptionId.trim(),
      topK,
      scoreThreshold,
      strategy,
    }),
  });
  if (!response.ok) throw new AuthApiError(await readApiError(response));
  return response.json() as Promise<KnowledgeBaseSearchResponse>;
}

async function authorizedJson<T>(path: string, accessToken: string): Promise<T> {
  const response = await fetch(`${config.SEP_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new AuthApiError(await readApiError(response));
  return response.json() as Promise<T>;
}

async function readApiError(response: Response): Promise<ApiError> {
  try {
    const body = await response.json() as Partial<ApiError> & { message?: string | string[] };
    return {
      statusCode: response.status,
      message: Array.isArray(body.message) ? body.message.join(', ') : body.message || response.statusText,
      error: body.error || 'HTTP Error',
    };
  } catch {
    return { statusCode: response.status, message: response.statusText, error: 'Unknown Error' };
  }
}

function normalizeSubscription(value: unknown): SubscriptionSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<SubscriptionSnapshot> & {
    subscriptionId?: unknown; employeeId?: unknown; id?: unknown; upgradeAvailable?: unknown;
  };
  const subscriptionId = typeof item.subscriptionId === 'string' ? item.subscriptionId : typeof item.id === 'string' ? item.id : null;
  const template = item.template;
  const employeeId = typeof item.employeeId === 'string'
    ? item.employeeId
    : template && typeof template.id === 'string' ? template.id : null;
  if (!subscriptionId || !employeeId || typeof item.name !== 'string' || typeof item.status !== 'string' ||
    typeof item.templateVersion !== 'string' || !template || typeof template.id !== 'string' || typeof template.name !== 'string' ||
    !Array.isArray(item.allowedModels)) return null;
  return {
    id: subscriptionId,
    subscriptionId,
    employeeId,
    name: item.name,
    status: item.status as SubscriptionSnapshot['status'],
    templateVersion: item.templateVersion,
    template: { id: template.id, name: template.name, avatar: typeof template.avatar === 'string' ? template.avatar : null },
    department: item.department && typeof item.department.id === 'string' && typeof item.department.name === 'string'
      ? { id: item.department.id, name: item.department.name } : null,
    allowedModels: item.allowedModels.filter((model): model is string => typeof model === 'string'),
    upgradeAvailable: item.upgradeAvailable === true,
  };
}

// ─────────────────────────────────────────────────────────────────
// Error Handling
// ─────────────────────────────────────────────────────────────────

export class AuthApiError extends Error {
  constructor(public readonly error: ApiError) {
    super(error.message);
    this.name = 'AuthApiError';
  }

  get statusCode(): number {
    return this.error.statusCode;
  }

  get isUnauthorized(): boolean {
    return this.error.statusCode === 401;
  }

  get isForbidden(): boolean {
    return this.error.statusCode === 403;
  }

  get isNetworkError(): boolean {
    return this.error.statusCode === 0 || this.error.statusCode >= 500;
  }
}
