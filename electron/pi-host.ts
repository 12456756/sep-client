/**
 * electron/pi-host.ts — Pi Session 生命周期管理
 *
 * 职责:
 *   - 管理 pi-coding-agent AgentSession 的创建、启动、停止
 *   - 执行任务（而不是单个 prompt）
 *   - 将 pi 事件映射到任务状态
 *   - 处理 tool_call 拦截的异步审批
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { buildSepExtensions } from '../pi-extension';
import type { TaskManager } from './task-manager';
import { TaskStatus } from './task-manager';
import { InstanceTokenManager } from './instance-token-manager';

export interface PiHostConfig {
  /** 事件回调 — pi session 事件转发给主进程 */
  onEvent: (event: unknown) => void;
  /** 工具审批请求 — 异步等待用户确认 */
  onToolApprovalRequest: (request: { toolName: string; input: unknown }) => Promise<boolean>;
  /** TaskManager 实例 */
  taskManager: TaskManager;
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
  private taskManager: TaskManager;
  private tokenManager: InstanceTokenManager;

  constructor(config: PiHostConfig) {
    this.config = config;
    this.taskManager = config.taskManager;
    this.tokenManager = new InstanceTokenManager();
  }

  /** 启动 pi session */
  async startSession(sessionConfig: SessionConfig): Promise<void> {
    if (this.session) {
      throw new Error('Session already running — call stopSession() first');
    }

    console.log('[pi-host] starting session for employee:', sessionConfig.employeeId);

    // 0. 初始化 token manager，获取第一个 instanceToken
    //    后续通过 getAccessToken() 读取，由 manager 负责自动刷新
    await this.tokenManager.initialize(
      sessionConfig.refreshToken,
      sessionConfig.employeeId
    );

    // 1. Create ModelRuntime
    this.modelRuntime = await ModelRuntime.create({ modelsPath: null });

    // 2. Register SEP gateway provider
    this.modelRuntime.registerProvider('sep-gateway', {
      name: 'SEP Gateway',
      baseUrl: sessionConfig.gatewayUrl,
      apiKey: 'placeholder',
      api: 'openai-completions',
      models: [{
        id: 'sep-employee',
        name: 'SEP Employee',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
      }],
    });

    const model = this.modelRuntime.getModel('sep-gateway', 'sep-employee');
    if (!model) throw new Error('Failed to resolve sep-employee model');

    // 3. Build SEP extensions
    const extensions = buildSepExtensions({
      getAccessToken: () => this.getAccessToken(),
      onToolApprovalRequest: async (request) => {
        // 工具审批时更新任务状态
        const currentTask = this.taskManager.getCurrentTask();
        if (currentTask) {
          this.taskManager.updateTaskStatus(currentTask.id, TaskStatus.WAITING_APPROVAL);
          this.taskManager.addTaskLog(
            currentTask.id,
            `等待审批: ${request.toolName}`,
            'warning'
          );
        }

        // 等待用户审批
        const approved = await this.config.onToolApprovalRequest(request);

        // 恢复任务状态
        if (currentTask) {
          if (approved) {
            this.taskManager.updateTaskStatus(currentTask.id, TaskStatus.RUNNING);
            this.taskManager.addTaskLog(currentTask.id, `用户批准: ${request.toolName}`);
          } else {
            this.taskManager.updateTaskStatus(currentTask.id, TaskStatus.FAILED, '用户拒绝工具执行');
            this.taskManager.addTaskLog(currentTask.id, `用户拒绝: ${request.toolName}`, 'error');
          }
        }

        return approved;
      },
    });

    // 4. Create ResourceLoader
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: '.pi',
      extensionFactories: extensions,
      noSkills: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    // 5. Create AgentSession
    const { session } = await createAgentSession({
      modelRuntime: this.modelRuntime,
      model,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
    });

    this.session = session;

    // 6. Subscribe to session events
    session.subscribe((event) => {
      this.handleSessionEvent(event);
    });

    console.log('[pi-host] session started');
  }

  /** 处理 session 事件 */
  private handleSessionEvent(event: any): void {
    const currentTask = this.taskManager.getCurrentTask();
    if (!currentTask) return;

    switch (event.type) {
      case 'agent_start':
        this.taskManager.updateTaskStatus(currentTask.id, TaskStatus.RUNNING);
        this.taskManager.addTaskLog(currentTask.id, 'AI 开始处理任务');
        break;

      case 'agent_settled':
        this.taskManager.updateTaskStatus(currentTask.id, TaskStatus.COMPLETED);
        this.taskManager.addTaskLog(currentTask.id, '任务完成');
        // TODO: 发送桌面通知
        break;

      case 'agent_end':
        if (event.error) {
          this.taskManager.updateTaskStatus(currentTask.id, TaskStatus.FAILED, event.error);
          this.taskManager.addTaskLog(currentTask.id, `任务失败: ${event.error}`, 'error');
        }
        if (event.willRetry) {
          this.taskManager.addTaskLog(currentTask.id, 'AI 将自动重试', 'warning');
        }
        break;

      case 'auto_retry_start':
        this.taskManager.addTaskLog(currentTask.id, '开始自动重试');
        break;

      case 'auto_retry_end':
        this.taskManager.addTaskLog(currentTask.id, '自动重试结束');
        break;

      case 'tool_execution_start':
        this.taskManager.addTaskLog(currentTask.id, `执行工具: ${event.toolName || 'unknown'}`);
        break;

      case 'tool_execution_end':
        this.taskManager.addTaskLog(currentTask.id, `工具执行完成: ${event.toolName || 'unknown'}`);
        break;

      case 'message_update':
        // 可选：记录 AI 的思考过程
        // 任务板模式可能不需要
        break;
    }

    // 转发事件到 renderer
    this.config.onEvent({
      type: event.type,
      taskId: currentTask.id,
      data: event,
    });
  }

  /** 执行任务 */
  async executeTask(taskId: string): Promise<void> {
    if (!this.session) {
      throw new Error('Session not started');
    }

    const task = this.taskManager.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // 设置当前任务
    this.taskManager.setCurrentTask(taskId);

    // 发送 prompt
    console.log('[pi-host] executing task:', taskId, task.title);
    this.session.prompt(task.prompt);
  }

  /** 停止 pi session */
  async stopSession(): Promise<void> {
    if (!this.session) return;

    console.log('[pi-host] stopping session');
    this.tokenManager.stop();
    this.session = null;
    this.modelRuntime = null;
  }

  /** 发送 prompt（兼容旧接口，但任务板模式应使用 executeTask） */
  async sendPrompt(text: string): Promise<void> {
    if (!this.session) {
      throw new Error('No active session');
    }
    console.log('[pi-host] prompt:', text.slice(0, 80));
    this.session.prompt(text);
  }

  /** 获取当前 access token */
  private async getAccessToken(): Promise<string> {
    // 返回当前有效的 instanceToken（自动刷新）
    return this.tokenManager.getValidTokenSync();
  }
}
