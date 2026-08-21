import { AuthApiError, getInstanceToken } from './auth-api';
import { config } from '../infrastructure/config';

const DEFAULT_TOKEN_TTL_SECONDS = 15 * 60;
const RETRY_DELAY_MS = 5_000;

export interface InstanceTokenManagerOptions {
  getRefreshToken: () => string;
  onAuthenticationRequired?: () => void;
}

export class InstanceTokenManager {
  private instanceToken: string | null = null;
  private expiresAt = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshPromise: Promise<string> | null = null;
  private instanceId: string | null = null;
  private generation = 0;
  private controller: AbortController | null = null;

  constructor(private readonly options: InstanceTokenManagerOptions) {}

  async initialize(instanceId: string): Promise<void> {
    this.stop();
    this.instanceId = instanceId;
    this.controller = new AbortController();
    await this.refreshNow();
  }

  async getValidToken(): Promise<string> {
    if (!this.instanceId) throw new Error('Instance token manager is not initialized');

    if (
      !this.instanceToken ||
      Date.now() + config.INSTANCE_TOKEN_REFRESH_BEFORE_MS >= this.expiresAt
    ) {
      return this.refreshNow();
    }
    return this.instanceToken;
  }

  stop(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.refreshPromise = null;
    this.instanceToken = null;
    this.expiresAt = 0;
    this.instanceId = null;
  }

  private refreshNow(): Promise<string> {
    if (this.refreshPromise) return this.refreshPromise;

    const generation = this.generation;
    const instanceId = this.instanceId;
    const controller = this.controller;
    if (!instanceId || !controller) {
      return Promise.reject(new Error('Instance token manager is not initialized'));
    }

    const request = this.performRefresh(generation, instanceId, controller.signal);
    const trackedRequest = request.finally(() => {
      if (this.refreshPromise === trackedRequest) this.refreshPromise = null;
    });
    this.refreshPromise = trackedRequest;
    return trackedRequest;
  }

  private async performRefresh(
    generation: number,
    instanceId: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const response = await getInstanceToken({
        refreshToken: this.options.getRefreshToken(),
        instanceId,
      }, signal);

      if (!this.isCurrent(generation, instanceId, signal)) {
        throw new DOMException('Stale instance token request', 'AbortError');
      }

      this.instanceToken = response.instanceToken;
      const expiresIn = response.expiresIn > 0
        ? response.expiresIn
        : DEFAULT_TOKEN_TTL_SECONDS;
      this.expiresAt = Date.now() + expiresIn * 1000;
      this.scheduleRefresh(expiresIn * 1000, generation, instanceId);
      return response.instanceToken;
    } catch (error) {
      if (this.isAbort(error) || !this.isCurrent(generation, instanceId, signal)) throw error;

      if (error instanceof AuthApiError && error.isUnauthorized) {
        this.stop();
        this.options.onAuthenticationRequired?.();
      } else if (this.instanceToken && Date.now() < this.expiresAt) {
        this.scheduleRetry(generation, instanceId);
      }
      throw error;
    }
  }

  private isCurrent(generation: number, instanceId: string, signal: AbortSignal): boolean {
    return generation === this.generation &&
      instanceId === this.instanceId &&
      signal === this.controller?.signal &&
      !signal.aborted;
  }

  private isAbort(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
  }

  private scheduleRefresh(tokenLifetimeMs: number, generation: number, instanceId: string): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const refreshLeadMs = Math.min(
      config.INSTANCE_TOKEN_REFRESH_BEFORE_MS,
      tokenLifetimeMs / 3,
    );
    const delay = Math.max(1_000, this.expiresAt - refreshLeadMs - Date.now());
    this.refreshTimer = setTimeout(() => {
      if (this.generation !== generation || this.instanceId !== instanceId) return;
      void this.refreshNow().catch((error: unknown) => {
        if (!this.isAbort(error)) console.error('[token-manager] automatic refresh failed:', error);
      });
    }, delay);
  }

  private scheduleRetry(generation: number, instanceId: string): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const remainingLifetime = this.expiresAt - Date.now();
    if (remainingLifetime <= 0) return;
    this.refreshTimer = setTimeout(() => {
      if (this.generation !== generation || this.instanceId !== instanceId) return;
      void this.refreshNow().catch((error: unknown) => {
        if (!this.isAbort(error)) console.error('[token-manager] refresh retry failed:', error);
      });
    }, Math.min(RETRY_DELAY_MS, remainingLifetime));
  }
}
