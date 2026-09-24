export type SkillLoadErrorKind = 'rate-limited' | 'auth' | 'forbidden' | 'network' | 'service' | 'unknown';

export interface SkillLoadFailureInput {
  message?: string;
  statusCode?: number;
}

export interface SkillLoadError {
  kind: SkillLoadErrorKind;
  message: string;
  statusCode?: number;
  retryAfterSeconds?: number;
}

export const DEFAULT_SKILL_RETRY_AFTER_SECONDS = 30;

function retryAfterSeconds(message: string | undefined): number {
  const match = message?.match(/(\d+)\s*秒/);
  const seconds = match ? Number(match[1]) : DEFAULT_SKILL_RETRY_AFTER_SECONDS;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_SKILL_RETRY_AFTER_SECONDS;
}

export function formatSkillRateLimitMessage(seconds: number): string {
  return `技能服务请求较多，请在 ${Math.max(0, Math.ceil(seconds))} 秒后重试。`;
}

export function classifySkillLoadError(input: SkillLoadFailureInput | unknown): SkillLoadError {
  const value = input && typeof input === 'object' ? input as SkillLoadFailureInput : {};
  const message = typeof value.message === 'string' ? value.message : '';
  const statusCode = typeof value.statusCode === 'number' ? value.statusCode : undefined;

  if (statusCode === 429) {
    const seconds = retryAfterSeconds(message);
    return { kind: 'rate-limited', message: formatSkillRateLimitMessage(seconds), statusCode, retryAfterSeconds: seconds };
  }
  if (statusCode === 401) return { kind: 'auth', message: '登录状态已过期，请重新登录。', statusCode };
  if (statusCode === 403) return { kind: 'forbidden', message: '当前账号没有查看这些技能的权限。', statusCode };
  if (statusCode !== undefined && statusCode >= 500) return { kind: 'service', message: '技能服务暂时不可用，请稍后重试。', statusCode };

  if (/failed to fetch|network|网络|连接|offline|econn|enotfound|timeout|超时/i.test(message)) {
    return { kind: 'network', message: '暂时无法连接技能服务，请检查网络后重试。', statusCode };
  }
  return { kind: 'unknown', message: message || '技能加载失败，请重试。', statusCode };
}
