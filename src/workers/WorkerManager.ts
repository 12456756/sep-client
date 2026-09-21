/**
 * Web Worker 管理器
 * 负责 Worker 生命周期管理和消息通信
 */

export interface WorkerMessage<T = unknown> {
  id: string;
  type: string;
  payload: T;
}

export interface WorkerResponse<T = unknown> {
  id: string;
  success: boolean;
  data?: T;
  error?: string;
}

export class WorkerManager {
  private worker: Worker | null = null;
  private pendingRequests: Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timeoutId: NodeJS.Timeout;
    }
  > = new Map();
  private requestIdCounter = 0;
  private readonly timeout: number;

  constructor(workerUrl: string | URL, timeout = 30000) {
    this.timeout = timeout;
    this.worker = new Worker(workerUrl, { type: 'module' });
    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = this.handleError.bind(this);
  }

  private handleMessage(event: MessageEvent<WorkerResponse>): void {
    const response = event.data;
    const pending = this.pendingRequests.get(response.id);

    if (!pending) {
      console.warn(`[WorkerManager] 收到未知请求的响应: ${response.id}`);
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(response.id);

    if (response.success) {
      pending.resolve(response.data);
    } else {
      pending.reject(new Error(response.error || 'Worker 执行失败'));
    }
  }

  private handleError(error: ErrorEvent): void {
    console.error('[WorkerManager] Worker 错误:', error);

    // 清理所有待处理的请求
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(`Worker 错误: ${error.message}`));
    });
    this.pendingRequests.clear();
  }

  /**
   * 向 Worker 发送消息并等待响应
   */
  async postMessage<TPayload, TResult>(
    type: string,
    payload: TPayload
  ): Promise<TResult> {
    if (!this.worker) {
      throw new Error('Worker 未初始化');
    }

    const id = `req_${++this.requestIdCounter}_${Date.now()}`;

    return new Promise<TResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Worker 请求超时 (${this.timeout}ms): ${type}`));
      }, this.timeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeoutId,
      });

      const message: WorkerMessage<TPayload> = { id, type, payload };
      this.worker!.postMessage(message);
    });
  }

  /**
   * 终止 Worker 并清理资源
   */
  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    // 拒绝所有待处理的请求
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Worker 已终止'));
    });
    this.pendingRequests.clear();
  }

  /**
   * 检查 Worker 是否活跃
   */
  isActive(): boolean {
    return this.worker !== null;
  }

  /**
   * 获取待处理请求数量
   */
  getPendingCount(): number {
    return this.pendingRequests.size;
  }
}
