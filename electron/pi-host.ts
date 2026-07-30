/**
 * electron/pi-host.ts — Pi Session 生命周期管理
 *
 * 职责:
 *   - 管理 pi-coding-agent AgentSession 的创建、启动、停止
 *   - 加载 SEP extension (guard + provider)
 *   - 接收 renderer 的 prompt 请求，转发给 pi session
 *   - 将 pi 事件转发给主进程 IPC
 *   - 处理 tool_call 拦截的异步审批（via onToolApprovalRequest callback）
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { buildSepExtensions } from '../pi-extension';

export interface PiHostConfig {
  /** 事件回调 — pi session 事件转发给主进程 */
  onEvent: (event: unknown) => void;
  /** 工具审批请求 — 异步等待用户确认 */
  onToolApprovalRequest: (request: { toolName: string; input: unknown }) => Promise<boolean>;
}

export interface SessionConfig {
  employeeId: string;
  gatewayUrl: string;
  refreshToken: string;
}

export class PiHost {
  private config: PiHostConfig;
  private session: AgentSession | null = null;
  private modelRuntime: ModelRuntime | null = null;
  private currentRefreshToken: string | null = null;

  constructor(config: PiHostConfig) {
    this.config = config;
  }

  /** 启动 pi session */
  async startSession(sessionConfig: SessionConfig): Promise<void> {
    if (this.session) {
      throw new Error('Session already running — call stopSession() first');
    }

    console.log('[pi-host] starting session for employee:', sessionConfig.employeeId);
    this.currentRefreshToken = sessionConfig.refreshToken;

    // 1. Create ModelRuntime
    this.modelRuntime = await ModelRuntime.create({ modelsPath: null });

    // 2. Register SEP gateway provider
    this.modelRuntime.registerProvider('sep-gateway', {
      name: 'SEP Gateway',
      baseUrl: sessionConfig.gatewayUrl,
      apiKey: 'placeholder', // replaced by before_provider_headers
      api: 'openai-completions',
      models: [
        {
          id: 'sep-employee',
          name: 'SEP Employee',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4096,
        },
      ],
    });

    const model = this.modelRuntime.getModel('sep-gateway', 'sep-employee');
    if (!model) throw new Error('Failed to resolve sep-employee model');

    // 3. Build SEP extensions (guard + provider with dynamic token injection)
    const extensions = buildSepExtensions({
      getAccessToken: () => this.getAccessToken(),
      onToolApprovalRequest: (request) => this.config.onToolApprovalRequest(request),
    });

    // 4. Create AgentSession
    this.session = await createAgentSession({
      modelRuntime: this.modelRuntime,
      model,
      resourceLoader: new DefaultResourceLoader({
        extensionFactories: extensions,
        noSkills: true,
        noContextFiles: true,
      }),
      sessionManager: SessionManager.inMemory(),
    });

    // 5. Subscribe to session events
    this.session.on('agent_start', (e: unknown) => this.config.onEvent({ type: 'agent_start', data: e }));
    this.session.on('agent_end', (e: unknown) => this.config.onEvent({ type: 'agent_end', data: e }));
    this.session.on('agent_settled', (e: unknown) => this.config.onEvent({ type: 'agent_settled', data: e }));
    this.session.on('message_start', (e: unknown) => this.config.onEvent({ type: 'message_start', data: e }));
    this.session.on('message_update', (e: unknown) => this.config.onEvent({ type: 'message_update', data: e }));
    this.session.on('message_end', (e: unknown) => this.config.onEvent({ type: 'message_end', data: e }));
    this.session.on('tool_execution_start', (e: unknown) => this.config.onEvent({ type: 'tool_execution_start', data: e }));
    this.session.on('tool_execution_end', (e: unknown) => this.config.onEvent({ type: 'tool_execution_end', data: e }));

    console.log('[pi-host] session started');
  }

  /** 停止 pi session */
  async stopSession(): Promise<void> {
    if (!this.session) return;

    console.log('[pi-host] stopping session');
    // AgentSession doesn't have explicit shutdown() in the types we saw,
    // but we can just nullify the reference and let GC handle cleanup
    this.session = null;
    this.modelRuntime = null;
    this.currentRefreshToken = null;
  }

  /** 发送 prompt 到 pi session */
  sendPrompt(text: string): void {
    if (!this.session) {
      throw new Error('No active session — call startSession() first');
    }
    console.log('[pi-host] prompt:', text.slice(0, 80));
    this.session.prompt(text);
  }

  /** 获取当前 access token (通过 refresh token 换取) */
  private async getAccessToken(): Promise<string> {
    if (!this.currentRefreshToken) {
      throw new Error('No refresh token available');
    }

    // TODO: 实际实现需要调用 SEP 后端 /auth/refresh 接口
    // 这里暂时返回 refresh token 作为占位
    console.log('[pi-host] getAccessToken called (TODO: implement refresh flow)');
    return `Bearer ${this.currentRefreshToken}`;
  }
}
