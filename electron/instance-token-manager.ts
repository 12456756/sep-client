/**
 * electron/instance-token-manager.ts — 实例 Token 自动刷新
 *
 * SEP 的 instanceToken 有效期为 15 分钟，需要定期刷新以支持长时间运行的任务。
 *
 * 职责:
 *   - 使用 refreshToken 获取 instanceToken
 *   - 提前 5 分钟自动刷新
 *   - 同步获取有效 token（供 before_provider_headers 使用）
 */

import { getInstanceToken } from './auth-api';

export class InstanceTokenManager {
  private instanceToken: string | null = null;
  private expiresAt: number = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshToken: string | null = null;
  private instanceId: string | null = null;

  /** 提前 5 分钟刷新 */
  private readonly REFRESH_BEFORE_MS = 5 * 60 * 1000;

  /**
   * 初始化并获取第一个 token
   */
  async initialize(refreshToken: string, instanceId: string): Promise<string> {
    this.refreshToken = refreshToken;
    this.instanceId = instanceId;

    await this.refreshTokenNow();
    this.scheduleRefresh();

    return this.instanceToken!;
  }

  /**
   * 立即刷新 token
   */
  private async refreshTokenNow(): Promise<void> {
    if (!this.refreshToken || !this.instanceId) {
      throw new Error('InstanceTokenManager not initialized');
    }

    console.log('[token-manager] refreshing instance token for:', this.instanceId);

    try {
      const response = await getInstanceToken({
        refreshToken: this.refreshToken,
        instanceId: this.instanceId,
      });

      this.instanceToken = response.instanceToken;
      // instanceToken 有效期 15 分钟（或使用 response.expiresIn）
      this.expiresAt = Date.now() + (response.expiresIn || 15 * 60) * 1000;

      console.log('[token-manager] token refreshed, expires at:', new Date(this.expiresAt).toISOString());
    } catch (error) {
      console.error('[token-manager] failed to refresh token:', error);
      throw error;
    }
  }

  /**
   * 安排下次刷新
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    // 计算刷新延迟：过期时间 - 提前量 - 当前时间
    const delay = Math.max(0, this.expiresAt - this.REFRESH_BEFORE_MS - Date.now());

    console.log('[token-manager] next refresh in', Math.round(delay / 1000), 'seconds');

    this.refreshTimer = setTimeout(async () => {
      try {
        await this.refreshTokenNow();
        this.scheduleRefresh();
      } catch (error) {
        console.error('[token-manager] auto-refresh failed:', error);
        // 3 秒后重试
        setTimeout(() => this.scheduleRefresh(), 3000);
      }
    }, delay);
  }

  /**
   * 同步获取当前有效 token
   * 供 before_provider_headers 使用（必须是同步的）
   */
  getValidTokenSync(): string {
    if (!this.instanceToken) {
      throw new Error('Instance token not initialized');
    }

    if (Date.now() >= this.expiresAt) {
      throw new Error('Instance token expired, refresh in progress');
    }

    return this.instanceToken;
  }

  /**
   * 停止自动刷新
   */
  stop(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.instanceToken = null;
    this.refreshToken = null;
    this.instanceId = null;
    console.log('[token-manager] stopped');
  }
}
