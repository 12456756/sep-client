import { createHash } from 'node:crypto';
import { AuthApiError, getEmploymentToken } from './platform-api';
import { config } from '../config';
import { describeError } from '../redact'
import { logger } from '../logger'

const log = logger.child('employment-token-manager')

const DEFAULT_TOKEN_TTL_SECONDS = 15 * 60;
const RETRY_DELAY_MS = 5_000;
const MAX_CACHED_TOKENS = 128;

interface CachedEmploymentToken {
  token: string;
  expiresAt: number;
}

interface PendingEmploymentTokenRequest {
  controller: AbortController;
  consumers: number;
  promise: Promise<CachedEmploymentToken>;
}

const employmentTokenCache = new Map<string, CachedEmploymentToken>();
const pendingEmploymentTokens = new Map<string, PendingEmploymentTokenRequest>();

function cacheKey(subscriptionId: string, refreshToken: string): string {
  return createHash('sha256').update(subscriptionId).update('\0').update(refreshToken).digest('hex');
}

function getCachedToken(key: string): CachedEmploymentToken | null {
  const now = Date.now();
  for (const [entryKey, value] of employmentTokenCache) {
    if (value.expiresAt <= now) employmentTokenCache.delete(entryKey);
  }
  return employmentTokenCache.get(key) ?? null;
}

function setCachedToken(key: string, value: CachedEmploymentToken): void {
  getCachedToken(key);
  if (!employmentTokenCache.has(key) && employmentTokenCache.size >= MAX_CACHED_TOKENS) {
    const oldestKey = employmentTokenCache.keys().next().value;
    if (oldestKey) employmentTokenCache.delete(oldestKey);
  }
  employmentTokenCache.set(key, value);
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Employment token request aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException('Employment token request aborted', 'AbortError'));
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    );
  });
}

function requestEmploymentToken(
  key: string,
  refreshToken: string,
  subscriptionId: string,
  signal: AbortSignal,
): Promise<CachedEmploymentToken> {
  let pending = pendingEmploymentTokens.get(key);
  if (!pending) {
    const controller = new AbortController();
    const promise = getEmploymentToken({ refreshToken, subscriptionId }, controller.signal).then(response => {
      const expiresIn = response.expiresIn > 0 ? response.expiresIn : DEFAULT_TOKEN_TTL_SECONDS;
      const value = { token: response.employmentToken, expiresAt: Date.now() + expiresIn * 1000 };
      setCachedToken(key, value);
      return value;
    });
    pending = { controller, consumers: 0, promise };
    pendingEmploymentTokens.set(key, pending);
    void promise.then(
      () => { if (pendingEmploymentTokens.get(key) === pending) pendingEmploymentTokens.delete(key) },
      () => { if (pendingEmploymentTokens.get(key) === pending) pendingEmploymentTokens.delete(key) },
    );
  }

  const request = pending;
  request.consumers += 1;
  return awaitWithAbort(request.promise, signal).finally(() => {
    request.consumers -= 1;
    if (request.consumers === 0 && pendingEmploymentTokens.get(key) === request) request.controller.abort();
  });
}

export interface EmploymentTokenManagerOptions {
  getRefreshToken: () => string;
  onAuthenticationRequired?: () => void;
}

export class EmploymentTokenManager {
  private employmentToken: string | null = null;
  private expiresAt = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshPromise: Promise<string> | null = null;
  private subscriptionId: string | null = null;
  private generation = 0;
  private controller: AbortController | null = null;

  constructor(private readonly options: EmploymentTokenManagerOptions) {}

  async initialize(subscriptionId: string): Promise<void> {
    this.stop();
    this.subscriptionId = subscriptionId;
    this.controller = new AbortController();
    await this.refreshNow();
  }

  async getValidToken(): Promise<string> {
    if (!this.subscriptionId) throw new Error('Employment token manager is not initialized');

    if (
      !this.employmentToken ||
      Date.now() + config.EMPLOYMENT_TOKEN_REFRESH_BEFORE_MS >= this.expiresAt
    ) {
      return this.refreshNow();
    }
    return this.employmentToken;
  }

  stop(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.refreshPromise = null;
    this.employmentToken = null;
    this.expiresAt = 0;
    this.subscriptionId = null;
  }

  private refreshNow(): Promise<string> {
    if (this.refreshPromise) return this.refreshPromise;

    const generation = this.generation;
    const subscriptionId = this.subscriptionId;
    const controller = this.controller;
    if (!subscriptionId || !controller) {
      return Promise.reject(new Error('Employment token manager is not initialized'));
    }

    const request = this.performRefresh(generation, subscriptionId, controller.signal);
    const trackedRequest = request.finally(() => {
      if (this.refreshPromise === trackedRequest) this.refreshPromise = null;
    });
    this.refreshPromise = trackedRequest;
    return trackedRequest;
  }

  private async performRefresh(
    generation: number,
    subscriptionId: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const refreshToken = this.options.getRefreshToken();
      const key = cacheKey(subscriptionId, refreshToken);
      const cached = getCachedToken(key);
      if (cached && Date.now() + config.EMPLOYMENT_TOKEN_REFRESH_BEFORE_MS < cached.expiresAt) {
        this.acceptToken(cached.token, cached.expiresAt, generation, subscriptionId, signal);
        return cached.token;
      }

      const refreshed = await requestEmploymentToken(key, refreshToken, subscriptionId, signal);
      this.acceptToken(refreshed.token, refreshed.expiresAt, generation, subscriptionId, signal);
      return refreshed.token;
    } catch (error) {
      if (this.isAbort(error) || !this.isCurrent(generation, subscriptionId, signal)) throw error;

      if (error instanceof AuthApiError && error.isUnauthorized) {
        this.stop();
        this.options.onAuthenticationRequired?.();
      } else if (this.employmentToken && Date.now() < this.expiresAt) {
        this.scheduleRetry(generation, subscriptionId);
      }
      throw error;
    }
  }

  private acceptToken(token: string, expiresAt: number, generation: number, subscriptionId: string, signal: AbortSignal): void {
    if (!this.isCurrent(generation, subscriptionId, signal)) {
      throw new DOMException('Stale instance token request', 'AbortError');
    }
    this.employmentToken = token;
    this.expiresAt = expiresAt;
    this.scheduleRefresh(expiresAt - Date.now(), generation, subscriptionId);
  }

  private isCurrent(generation: number, subscriptionId: string, signal: AbortSignal): boolean {
    return generation === this.generation &&
      subscriptionId === this.subscriptionId &&
      signal === this.controller?.signal &&
      !signal.aborted;
  }

  private isAbort(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
  }

  private scheduleRefresh(tokenLifetimeMs: number, generation: number, subscriptionId: string): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const refreshLeadMs = Math.min(
      config.EMPLOYMENT_TOKEN_REFRESH_BEFORE_MS,
      tokenLifetimeMs / 3,
    );
    const delay = Math.max(1_000, this.expiresAt - refreshLeadMs - Date.now());
    this.refreshTimer = setTimeout(() => {
      if (this.generation !== generation || this.subscriptionId !== subscriptionId) return;
      void this.refreshNow().catch((error: unknown) => {
        if (!this.isAbort(error)) log.error('automatic refresh failed', { cause: describeError(error) });
      });
    }, delay);
  }

  private scheduleRetry(generation: number, subscriptionId: string): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const remainingLifetime = this.expiresAt - Date.now();
    if (remainingLifetime <= 0) return;
    this.refreshTimer = setTimeout(() => {
      if (this.generation !== generation || this.subscriptionId !== subscriptionId) return;
      void this.refreshNow().catch((error: unknown) => {
        if (!this.isAbort(error)) log.error('refresh retry failed', { cause: describeError(error) });
      });
    }, Math.min(RETRY_DELAY_MS, remainingLifetime));
  }
}
