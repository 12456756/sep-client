/**
 * 性能监控工具
 * 用于追踪和记录应用性能指标
 */

export interface PerformanceMetrics {
  pageLoadTime: number;
  domReadyTime: number;
  firstContentfulPaint?: number;
  largestContentfulPaint?: number;
  firstInputDelay?: number;
  cumulativeLayoutShift?: number;
  timestamp: number;
}

/**
 * 测量页面加载性能
 */
export function measurePageLoad(): void {
  if (!window.performance) {
    console.warn('Performance API not available');
    return;
  }

  window.addEventListener('load', () => {
    // 使用 setTimeout 确保所有性能指标都已记录
    setTimeout(() => {
      const perfData = window.performance.timing;
      const navigation = window.performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;

      const metrics: PerformanceMetrics = {
        pageLoadTime: perfData.loadEventEnd - perfData.navigationStart,
        domReadyTime: perfData.domContentLoadedEventEnd - perfData.navigationStart,
        timestamp: Date.now(),
      };

      // 获取 Web Vitals 指标
      if (navigation) {
        metrics.firstContentfulPaint = navigation.domContentLoadedEventEnd - navigation.fetchStart;
      }

      // 获取 LCP (Largest Contentful Paint)
      try {
        const lcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const lastEntry = entries[entries.length - 1] as PerformanceEntry & { renderTime?: number; loadTime?: number };
          metrics.largestContentfulPaint = lastEntry.renderTime || lastEntry.loadTime || 0;
        });
        lcpObserver.observe({ entryTypes: ['largest-contentful-paint'] });
      } catch (_error) {
        // LCP 不可用
      }

      // 获取 FID (First Input Delay)
      try {
        const fidObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          entries.forEach((entry) => {
            const fidEntry = entry as PerformanceEntry & { processingStart?: number };
            metrics.firstInputDelay = fidEntry.processingStart ? fidEntry.processingStart - entry.startTime : 0;
          });
        });
        fidObserver.observe({ entryTypes: ['first-input'] });
      } catch (_error) {
        // FID 不可用
      }

      // 获取 CLS (Cumulative Layout Shift)
      try {
        let clsValue = 0;
        const clsObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          entries.forEach((entry) => {
            const layoutShiftEntry = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
            if (!layoutShiftEntry.hadRecentInput) {
              clsValue += layoutShiftEntry.value || 0;
            }
          });
          metrics.cumulativeLayoutShift = clsValue;
        });
        clsObserver.observe({ entryTypes: ['layout-shift'] });
      } catch (_error) {
        // CLS 不可用
      }

      // 记录到控制台（开发环境）
      if (import.meta.env.DEV) {
        console.log('📊 Performance Metrics:', {
          'Page Load': `${metrics.pageLoadTime}ms`,
          'DOM Ready': `${metrics.domReadyTime}ms`,
          'FCP': metrics.firstContentfulPaint ? `${metrics.firstContentfulPaint}ms` : 'N/A',
          'LCP': metrics.largestContentfulPaint ? `${metrics.largestContentfulPaint}ms` : 'N/A',
          'FID': metrics.firstInputDelay ? `${metrics.firstInputDelay}ms` : 'N/A',
          'CLS': metrics.cumulativeLayoutShift ? metrics.cumulativeLayoutShift.toFixed(3) : 'N/A',
        });
      }

      // 发送到 Electron 主进程
      if (window.electronAPI?.logPerformance) {
        void window.electronAPI.logPerformance(metrics as unknown as Record<string, number | string | undefined>).catch(() => undefined);
      }
    }, 0);
  });
}

/**
 * 测量组件渲染性能
 */
export function measureComponentRender(componentName: string, callback: () => void): void {
  const startTime = performance.now();

  callback();

  const endTime = performance.now();
  const renderTime = endTime - startTime;

  if (import.meta.env.DEV && renderTime > 16) { // 超过 16ms (60fps) 警告
    console.warn(`⚠️ Slow render: ${componentName} took ${renderTime.toFixed(2)}ms`);
  }
}

/**
 * 资源加载性能分析
 */
export function analyzeResourceTiming(): void {
  if (!window.performance) return;

  const resources = window.performance.getEntriesByType('resource') as PerformanceResourceTiming[];

  const analysis = {
    totalResources: resources.length,
    totalSize: 0,
    totalDuration: 0,
    byType: {} as Record<string, { count: number; duration: number }>,
  };

  resources.forEach((resource) => {
    const type = resource.initiatorType;
    const duration = resource.duration;

    if (!analysis.byType[type]) {
      analysis.byType[type] = { count: 0, duration: 0 };
    }

    analysis.byType[type].count++;
    analysis.byType[type].duration += duration;
    analysis.totalDuration += duration;
  });

  if (import.meta.env.DEV) {
    console.log('📦 Resource Loading Analysis:', analysis);
  }
}

/**
 * 内存使用监控
 */
export function monitorMemoryUsage(): void {
  if (!('memory' in performance)) {
    console.warn('Memory API not available');
    return;
  }

  const memory = (performance as Performance & { memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  }}).memory;

  if (!memory) return;

  const usedMB = (memory.usedJSHeapSize / 1024 / 1024).toFixed(2);
  const totalMB = (memory.totalJSHeapSize / 1024 / 1024).toFixed(2);
  const limitMB = (memory.jsHeapSizeLimit / 1024 / 1024).toFixed(2);

  if (import.meta.env.DEV) {
    console.log('💾 Memory Usage:', {
      used: `${usedMB} MB`,
      total: `${totalMB} MB`,
      limit: `${limitMB} MB`,
      percentage: `${((memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100).toFixed(1)}%`,
    });
  }

  // 警告：内存使用超过 80%
  if (memory.usedJSHeapSize / memory.jsHeapSizeLimit > 0.8) {
    console.warn('⚠️ High memory usage detected');
  }
}

/**
 * 初始化性能监控
 */
export function initPerformanceMonitoring(): void {
  if (import.meta.env.DEV) {
    measurePageLoad();

    // 5 秒后分析资源加载
    setTimeout(analyzeResourceTiming, 5000);

    // 每 30 秒检查一次内存使用
    setInterval(monitorMemoryUsage, 30000);
  }
}
