import { useState, useEffect } from 'react';

interface PerformanceMetrics {
  pageLoad: number;
  domReady: number;
  fcp: number;
  lcp: number;
  fid: number;
  cls: number;
  ttfb: number;
  resources: number;
  memory: number;
}

interface PerformanceMonitorProps {
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  minimized?: boolean;
}

export function PerformanceMonitor({
  position = 'bottom-right',
  minimized: initialMinimized = false
}: PerformanceMonitorProps) {
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);
  const [minimized, setMinimized] = useState(initialMinimized);
  const [memory, setMemory] = useState<number>(0);

  useEffect(() => {
    // 获取初始性能指标
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const paint = performance.getEntriesByType('paint');

    const fcp = paint.find(p => p.name === 'first-contentful-paint')?.startTime || 0;
    const lcp = paint.find(p => p.name === 'largest-contentful-paint')?.startTime || 0;

    setMetrics({
      pageLoad: navigation.loadEventEnd - navigation.fetchStart,
      domReady: navigation.domContentLoadedEventEnd - navigation.fetchStart,
      fcp,
      lcp,
      fid: 0, // First Input Delay 需要用户交互
      cls: 0, // Cumulative Layout Shift
      ttfb: navigation.responseStart - navigation.requestStart,
      resources: performance.getEntriesByType('resource').length,
      memory: 0,
    });

    // 内存监控
    const memoryInterval = setInterval(() => {
      if ('memory' in performance) {
        const mem = (performance as any).memory;
        setMemory(mem.usedJSHeapSize);
        setMetrics((prev: PerformanceMetrics | null) => prev ? { ...prev, memory: mem.usedJSHeapSize } : null);
      }
    }, 2000);

    return () => {
      clearInterval(memoryInterval);
    };
  }, []);

  if (!metrics) return null;

  const positionClasses = {
    'top-left': 'top-4 left-4',
    'top-right': 'top-4 right-4',
    'bottom-left': 'bottom-4 left-4',
    'bottom-right': 'bottom-4 right-4',
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const getPerformanceLevel = (metric: string, value: number): 'good' | 'needs-improvement' | 'poor' => {
    const thresholds = {
      fcp: { good: 1800, poor: 3000 },
      lcp: { good: 2500, poor: 4000 },
      fid: { good: 100, poor: 300 },
      cls: { good: 0.1, poor: 0.25 },
      ttfb: { good: 800, poor: 1800 },
    };

    const threshold = thresholds[metric as keyof typeof thresholds];
    if (!threshold) return 'good';

    if (value <= threshold.good) return 'good';
    if (value <= threshold.poor) return 'needs-improvement';
    return 'poor';
  };

  const getStatusColor = (level: 'good' | 'needs-improvement' | 'poor'): string => {
    return {
      good: 'bg-green-500',
      'needs-improvement': 'bg-yellow-500',
      poor: 'bg-red-500',
    }[level];
  };

  if (minimized) {
    return (
      <div
        className={`fixed ${positionClasses[position]} z-50 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700`}
      >
        <button
          onClick={() => setMinimized(false)}
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          title="展开性能监控"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div
      className={`fixed ${positionClasses[position]} z-50 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-4 min-w-[280px] max-w-[320px]`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <h3 className="font-semibold text-sm text-gray-900 dark:text-gray-100">
            性能监控
          </h3>
        </div>
        <button
          onClick={() => setMinimized(true)}
          className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
          title="最小化"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
          </svg>
        </button>
      </div>

      {/* Metrics */}
      <div className="space-y-2.5">
        {/* Core Web Vitals */}
        <div>
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">
            Core Web Vitals
          </div>
          <div className="space-y-1.5">
            <MetricRow
              label="FCP"
              value={`${Math.round(metrics.fcp)}ms`}
              level={getPerformanceLevel('fcp', metrics.fcp)}
              getStatusColor={getStatusColor}
            />
            <MetricRow
              label="LCP"
              value={`${Math.round(metrics.lcp)}ms`}
              level={getPerformanceLevel('lcp', metrics.lcp)}
              getStatusColor={getStatusColor}
            />
            <MetricRow
              label="TTFB"
              value={`${Math.round(metrics.ttfb)}ms`}
              level={getPerformanceLevel('ttfb', metrics.ttfb)}
              getStatusColor={getStatusColor}
            />
          </div>
        </div>

        {/* Load Metrics */}
        <div>
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">
            加载指标
          </div>
          <div className="space-y-1.5">
            <MetricRow
              label="页面加载"
              value={`${Math.round(metrics.pageLoad)}ms`}
              level="good"
              getStatusColor={getStatusColor}
            />
            <MetricRow
              label="DOM 就绪"
              value={`${Math.round(metrics.domReady)}ms`}
              level="good"
              getStatusColor={getStatusColor}
            />
          </div>
        </div>

        {/* Resources */}
        <div>
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">
            资源统计
          </div>
          <div className="space-y-1.5">
            <MetricRow
              label="资源数量"
              value={`${metrics.resources}`}
              level="good"
              getStatusColor={getStatusColor}
            />
            <MetricRow
              label="内存占用"
              value={formatBytes(memory)}
              level="good"
              getStatusColor={getStatusColor}
            />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
          <span>实时更新</span>
          <div className="flex items-center gap-1">
            <div className={`w-1.5 h-1.5 rounded-full ${getStatusColor(getPerformanceLevel('lcp', metrics.lcp))}`} />
            <span className="capitalize">
              {getPerformanceLevel('lcp', metrics.lcp) === 'good' ? '良好' :
               getPerformanceLevel('lcp', metrics.lcp) === 'needs-improvement' ? '需改进' : '较差'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

interface MetricRowProps {
  label: string;
  value: string;
  level: 'good' | 'needs-improvement' | 'poor';
  getStatusColor: (level: 'good' | 'needs-improvement' | 'poor') => string;
}

function MetricRow({ label, value, level, getStatusColor }: MetricRowProps) {
  return (
    <div className="flex items-center justify-between text-sm">
      <div className="flex items-center gap-1.5">
        <div className={`w-1.5 h-1.5 rounded-full ${getStatusColor(level)}`} />
        <span className="text-gray-700 dark:text-gray-300">{label}</span>
      </div>
      <span className="font-mono text-gray-900 dark:text-gray-100">{value}</span>
    </div>
  );
}
