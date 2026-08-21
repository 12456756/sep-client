/**
 * SEP Authentication API
 *
 * Handles all authentication-related API calls to SEP backend.
 */

import { config } from '../infrastructure/config';
import type { EmployeeInstanceSnapshot } from '../../src/shared/types';

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
  expiresIn: number;
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

export type ClientInstance = EmployeeInstanceSnapshot;

export interface InstanceTokenRequest {
  refreshToken: string;
  instanceId: string;
}

export interface InstanceTokenResponse {
  instanceToken: string;
  expiresIn: number;
  instance: {
    id: string;
    name: string;
    templateId: string;
    status: string;
  };
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

/**
 * Get list of authorized AI employee instances
 *
 * GET /client/instances
 */
export async function getInstances(accessToken: string): Promise<ClientInstance[]> {
  const response = await fetch(`${config.SEP_BASE_URL}/client/instances`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
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

  return response.json() as Promise<ClientInstance[]>;
}

/**
 * Exchange refresh token for instance-level access token
 *
 * POST /client/auth/token
 */
export async function getInstanceToken(
  req: InstanceTokenRequest,
  signal?: AbortSignal,
): Promise<InstanceTokenResponse> {
  const response = await fetch(`${config.SEP_BASE_URL}/client/auth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req),
    signal,
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

  return response.json() as Promise<InstanceTokenResponse>;
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
