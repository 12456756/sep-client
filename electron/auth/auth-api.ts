/** SEP authentication and subscription APIs used by the Electron main process. */

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

export interface ApiError {
  statusCode: number;
  message: string;
  error: string;
}

async function parseError(response: Response): Promise<AuthApiError> {
  let error: ApiError;
  try {
    error = await response.json() as ApiError;
  } catch {
    error = { statusCode: response.status, message: response.statusText, error: 'Unknown Error' };
  }
  return new AuthApiError(error);
}

export async function login(req: LoginRequest): Promise<LoginResponse> {
  const response = await fetch(`${config.SEP_BASE_URL}/client/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!response.ok) throw await parseError(response);
  return response.json() as Promise<LoginResponse>;
}

interface SubscriptionPayload {
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
  const id = typeof item.subscriptionId === 'string' ? item.subscriptionId : '';
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
    allowedModels: Array.isArray(item.allowedModels) ? item.allowedModels.filter((model): model is string => typeof model === 'string') : [],
  };
}

/** Fetch the current member's active employee subscriptions. */
export async function getInstances(accessToken: string): Promise<ClientInstance[]> {
  const headers = { 'Authorization': `Bearer ${accessToken}` };
  const response = await fetch(`${config.SEP_BASE_URL}/client/subscriptions`, { headers });
  if (!response.ok) throw await parseError(response);
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) throw new AuthApiError({ statusCode: 502, message: 'Invalid subscription response.', error: 'Bad Gateway' });
  return payload.map(normalizeSubscription);
}

/** Exchange the client refresh token for a subscription-scoped employment token. */
export async function getInstanceToken(req: InstanceTokenRequest, signal?: AbortSignal): Promise<InstanceTokenResponse> {
  const response = await fetch(`${config.SEP_BASE_URL}/client/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (!response.ok) throw await parseError(response);
  return response.json() as Promise<InstanceTokenResponse>;
}

export class AuthApiError extends Error {
  constructor(public readonly error: ApiError) {
    super(error.message);
    this.name = 'AuthApiError';
  }
  get statusCode(): number { return this.error.statusCode; }
  get isUnauthorized(): boolean { return this.error.statusCode === 401; }
  get isForbidden(): boolean { return this.error.statusCode === 403; }
  get isNetworkError(): boolean { return this.error.statusCode === 0 || this.error.statusCode >= 500; }
}
