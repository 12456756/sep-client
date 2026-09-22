/**
 * useWorker Hook
 * 简化 Web Worker 的使用，提供 React 友好的 API
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { WorkerManager } from './WorkerManager';

const DATA_PROCESSOR_WORKER_URL = new URL('./data-processor.worker.ts', import.meta.url);

interface UseWorkerOptions {
  timeout?: number;
  autoTerminate?: boolean;
}

interface UseWorkerResult<T> {
  execute: <TPayload>(type: string, payload: TPayload) => Promise<T>;
  isLoading: boolean;
  error: Error | null;
  isActive: boolean;
  terminate: () => void;
}

/**
 * 使用 Web Worker 的 React Hook
 *
 * @param workerUrl Worker 脚本的 URL
 * @param options 配置选项
 * @returns Worker 操作接口
 *
 * @example
 * ```tsx
 * const { execute, isLoading } = useWorker<Employee[]>(
 *   new URL('./workers/data-processor.worker.ts', import.meta.url)
 * );
 *
 * const sortedData = await execute('sort', { data, sort: { field: 'name', order: 'asc' } });
 * ```
 */
export function useWorker<T = unknown>(
  workerUrl: string | URL,
  options: UseWorkerOptions = {}
): UseWorkerResult<T> {
  const { timeout = 30000, autoTerminate = true } = options;

  const workerManagerRef = useRef<WorkerManager | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [isActive, setIsActive] = useState(false);

  // 初始化 Worker
  useEffect(() => {
    workerManagerRef.current = new WorkerManager(workerUrl, timeout);
    setIsActive(true);

    return () => {
      if (autoTerminate && workerManagerRef.current) {
        workerManagerRef.current.terminate();
        workerManagerRef.current = null;
        setIsActive(false);
      }
    };
  }, [workerUrl, timeout, autoTerminate]);

  // 执行 Worker 任务
  const execute = useCallback(
    async <TPayload,>(type: string, payload: TPayload): Promise<T> => {
      if (!workerManagerRef.current) {
        throw new Error('Worker 未初始化');
      }

      setIsLoading(true);
      setError(null);

      try {
        const result = await workerManagerRef.current.postMessage<TPayload, T>(
          type,
          payload
        );
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  // 手动终止 Worker
  const terminate = useCallback(() => {
    if (workerManagerRef.current) {
      workerManagerRef.current.terminate();
      workerManagerRef.current = null;
      setIsActive(false);
    }
  }, []);

  return {
    execute,
    isLoading,
    error,
    isActive,
    terminate,
  };
}

/**
 * 数据处理 Worker 的专用 Hook
 * 为常见的数据处理任务提供便捷接口
 */
export function useDataProcessor<T extends Record<string, unknown>>() {
  const { execute, isLoading, error, isActive } = useWorker<T[]>(
    DATA_PROCESSOR_WORKER_URL
  );

  const sort = useCallback(
    async (data: T[], field: string, order: 'asc' | 'desc' = 'asc'): Promise<T[]> => {
      return execute('sort', { data, sort: { field, order } });
    },
    [execute]
  );

  const filter = useCallback(
    async (
      data: T[],
      filters: Array<{
        field: string;
        operator: 'eq' | 'ne' | 'contains' | 'startsWith' | 'in';
        value: unknown;
      }>
    ): Promise<T[]> => {
      return execute('filter', { data, filters });
    },
    [execute]
  );

  const search = useCallback(
    async (
      data: T[],
      query: string,
      fields: string[],
      caseSensitive = false
    ): Promise<T[]> => {
      return execute('search', { data, search: { query, fields, caseSensitive } });
    },
    [execute]
  );

  const process = useCallback(
    async (
      data: T[],
      options: {
        sort?: { field: string; order: 'asc' | 'desc' };
        filters?: Array<{
          field: string;
          operator: 'eq' | 'ne' | 'contains' | 'startsWith' | 'in';
          value: unknown;
        }>;
        search?: { query: string; fields: string[]; caseSensitive?: boolean };
      }
    ): Promise<T[]> => {
      return execute('process', { data, ...options });
    },
    [execute]
  );

  return {
    sort,
    filter,
    search,
    process,
    isLoading,
    error,
    isActive,
  };
}
