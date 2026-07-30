/**
 * pi-extension/index.ts — SEP 扩展工厂入口
 *
 * 职责:
 *   1. 组合 permission guard + provider token injection 两个扩展
 *   2. 暴露 buildSepExtensions() 给 Electron 主进程使用
 *
 * 架构:
 *   - guard.ts  → 权限拦截（high-risk tools 需审批）
 *   - provider.ts → 动态令牌注入（before_provider_headers）
 *   - index.ts  → 组合导出
 */

import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { buildPermissionGuard } from './guard';
import { buildSepGatewayProvider } from './provider';

export interface SepExtensionConfig {
  /** 获取当前 access token (每次 LLM 请求前调用) */
  getAccessToken: () => Promise<string> | string;
  /** 工具审批请求回调 (async) */
  onToolApprovalRequest: (request: { toolName: string; input: unknown }) => Promise<boolean>;
}

/**
 * 构建 SEP 扩展集合
 *
 * @param config - 扩展配置（token 获取 + 审批回调）
 * @returns ExtensionFactory[] 传给 DefaultResourceLoader
 */
export function buildSepExtensions(config: SepExtensionConfig): ExtensionFactory[] {
  return [
    buildPermissionGuard({
      onToolApprovalRequest: config.onToolApprovalRequest,
    }),
    buildSepGatewayProvider({
      getAccessToken: config.getAccessToken,
    }),
  ];
}
