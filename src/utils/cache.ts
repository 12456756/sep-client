/**
 * 应用级缓存管理器
 * 用于缓存 API 响应、计算结果等数据
 */

interface CacheItem<T> {
  data: T;
  expiry: number;
  createdAt: number;
}

interface CacheOptions {
  ttl?: number; // 生存时间（毫秒）
  maxSize?: number; // 最大缓存项数
}

class CacheManager {
  private cache = new Map<string, CacheItem<unknown>>();
  private defaultTTL = 300000; // 默认 5 分钟
  private maxSize = 100; // 默认最大 100 项

  /**
   * 设置缓存项
   */
  set<T>(key: string, data: T, ttl = this.defaultTTL): void {
    // 如果缓存已满，删除最早的项
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      data,
      expiry: Date.now() + ttl,
      createdAt: Date.now(),
    });
  }

  /**
   * 获取缓存项
   */
  get<T>(key: string): T | null {
    const item = this.cache.get(key) as CacheItem<T> | undefined;

    if (!item) {
      return null;
    }

    // 检查是否过期
    if (Date.now() > item.expiry) {
      this.cache.delete(key);
      return null;
    }

    return item.data;
  }

  /**
   * 检查缓存是否存在且未过期
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * 删除缓存项
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 获取或设置缓存（缓存未命中时执行 fetcher）
   */
  async getOrFetch<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    const cached = this.get<T>(key);

    if (cached !== null) {
      return cached;
    }

    const data = await fetcher();
    this.set(key, data, ttl);
    return data;
  }

  /**
   * 批量设置缓存
   */
  setMany<T>(items: Array<{ key: string; data: T; ttl?: number }>): void {
    items.forEach(({ key, data, ttl }) => {
      this.set(key, data, ttl);
    });
  }

  /**
   * 批量获取缓存
   */
  getMany<T>(keys: string[]): Map<string, T | null> {
    const result = new Map<string, T | null>();
    keys.forEach((key) => {
      result.set(key, this.get<T>(key));
    });
    return result;
  }

  /**
   * 删除匹配模式的所有缓存项
   */
  deletePattern(pattern: string | RegExp): number {
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    let deletedCount = 0;

    this.cache.forEach((_, key) => {
      if (regex.test(key)) {
        this.cache.delete(key);
        deletedCount++;
      }
    });

    return deletedCount;
  }

  /**
   * 清理所有过期的缓存项
   */
  cleanup(): number {
    const now = Date.now();
    let cleanedCount = 0;

    this.cache.forEach((item, key) => {
      if (now > item.expiry) {
        this.cache.delete(key);
        cleanedCount++;
      }
    });

    return cleanedCount;
  }

  /**
   * 获取缓存统计信息
   */
  getStats() {
    const now = Date.now();
    let expiredCount = 0;
    let totalSize = 0;

    this.cache.forEach((item) => {
      if (now > item.expiry) {
        expiredCount++;
      }
      // 粗略估算大小（字节）
      totalSize += JSON.stringify(item.data).length;
    });

    return {
      totalItems: this.cache.size,
      expiredItems: expiredCount,
      activeItems: this.cache.size - expiredCount,
      estimatedSize: totalSize,
      maxSize: this.maxSize,
    };
  }

  /**
   * 配置缓存管理器
   */
  configure(options: CacheOptions): void {
    if (options.ttl !== undefined) {
      this.defaultTTL = options.ttl;
    }
    if (options.maxSize !== undefined) {
      this.maxSize = options.maxSize;
    }
  }
}

// 全局缓存实例
export const cache = new CacheManager();

// 定期清理过期缓存（每 5 分钟）
if (typeof window !== 'undefined') {
  setInterval(() => {
    const cleaned = cache.cleanup();
    if (import.meta.env.DEV && cleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} expired cache items`);
    }
  }, 300000);
}

/**
 * React Hook 用于缓存数据
 */
import { useEffect, useState } from 'react';

export function useCachedData<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl?: number
): { data: T | null; loading: boolean; error: Error | null; refetch: () => Promise<void> } {
  const [data, setData] = useState<T | null>(cache.get<T>(key));
  const [loading, setLoading] = useState(!data);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await cache.getOrFetch(key, fetcher, ttl);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!data) {
      void fetchData();
    }
  }, [key]);

  return {
    data,
    loading,
    error,
    refetch: fetchData,
  };
}
