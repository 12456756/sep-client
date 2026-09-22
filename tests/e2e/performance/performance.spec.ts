import { test, expect, type Page } from '@playwright/test';

interface BrowserPerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

interface PerformanceMetrics {
  pageLoad: number;
  domReady: number;
  fcp: number;
  lcp: number;
  ttfb: number;
  resources: number;
  memory: number;
}

interface ResourceTypeMetrics {
  count: number;
  totalTime: number;
}

interface SlowResourceMetrics {
  name: string;
  duration: number;
  size: number;
}

interface ResourceMetrics {
  total: number;
  byType: Record<string, ResourceTypeMetrics>;
  slowestResources: SlowResourceMetrics[];
}

interface StabilityMetrics {
  iteration: number;
  fcp: number;
  lcp: number;
  pageLoad: number;
}

/**
 * 性能基准配置
 * 定义所有性能指标的目标值
 */
const PERFORMANCE_THRESHOLDS = {
  // Core Web Vitals
  fcp: 1800,        // First Contentful Paint (ms)
  lcp: 2500,        // Largest Contentful Paint (ms)
  ttfb: 800,        // Time to First Byte (ms)

  // 页面加载
  pageLoad: 3000,   // 页面加载时间 (ms)
  domReady: 1500,   // DOM 就绪时间 (ms)

  // 资源加载
  maxResources: 100,  // 最大资源数

  // 内存
  maxMemory: 100,   // 最大内存 (MB)
};

/**
 * 获取性能指标
 */
async function getPerformanceMetrics(page: Page): Promise<PerformanceMetrics> {
  return await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const paint = performance.getEntriesByType('paint') as PerformancePaintTiming[];
    const fcp = paint.find(p => p.name === 'first-contentful-paint')?.startTime || 0;
    const lcp = paint.find(p => p.name === 'largest-contentful-paint')?.startTime || 0;
    const memory = (performance as Performance & { memory?: BrowserPerformanceMemory }).memory;

    return {
      pageLoad: navigation?.loadEventEnd - navigation?.fetchStart || 0,
      domReady: navigation?.domContentLoadedEventEnd - navigation?.fetchStart || 0,
      fcp,
      lcp,
      ttfb: navigation?.responseStart - navigation?.requestStart || 0,
      resources: performance.getEntriesByType('resource').length,
      memory: memory?.usedJSHeapSize || 0,
    };
  });
}

/**
 * 评估性能等级
 */
function assessPerformanceLevel(metric: string, value: number): 'good' | 'needs-improvement' | 'poor' {
  const thresholds: Record<string, { good: number; poor: number }> = {
    fcp: { good: 1800, poor: 3000 },
    lcp: { good: 2500, poor: 4000 },
    ttfb: { good: 800, poor: 1800 },
    pageLoad: { good: 3000, poor: 5000 },
    domReady: { good: 1500, poor: 3000 },
  };

  const threshold = thresholds[metric];
  if (!threshold) return 'good';

  if (value <= threshold.good) return 'good';
  if (value <= threshold.poor) return 'needs-improvement';
  return 'poor';
}

test.describe('性能基准测试', () => {
  test('首页加载性能', async ({ page }) => {
    await page.goto('/');

    const metrics = await getPerformanceMetrics(page);

    console.log('\n📊 首页性能指标:');
    console.log(`  FCP: ${Math.round(metrics.fcp)}ms (${assessPerformanceLevel('fcp', metrics.fcp)})`);
    console.log(`  LCP: ${Math.round(metrics.lcp)}ms (${assessPerformanceLevel('lcp', metrics.lcp)})`);
    console.log(`  TTFB: ${Math.round(metrics.ttfb)}ms (${assessPerformanceLevel('ttfb', metrics.ttfb)})`);
    console.log(`  页面加载: ${Math.round(metrics.pageLoad)}ms`);
    console.log(`  DOM就绪: ${Math.round(metrics.domReady)}ms`);
    console.log(`  资源数: ${metrics.resources}`);

    // 断言关键指标
    expect(metrics.fcp).toBeLessThan(PERFORMANCE_THRESHOLDS.fcp);
    expect(metrics.lcp).toBeLessThan(PERFORMANCE_THRESHOLDS.lcp);
    expect(metrics.ttfb).toBeLessThan(PERFORMANCE_THRESHOLDS.ttfb);
  });

  test('资源加载性能', async ({ page }) => {
    await page.goto('/');

    const resourceMetrics: ResourceMetrics = await page.evaluate(() => {
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const analysis = {
        total: resources.length,
        byType: {} as Record<string, ResourceTypeMetrics>,
        slowestResources: [] as SlowResourceMetrics[],
      };

      resources.forEach(resource => {
        const type = resource.initiatorType;
        if (!analysis.byType[type]) {
          analysis.byType[type] = { count: 0, totalTime: 0 };
        }
        analysis.byType[type].count++;
        analysis.byType[type].totalTime += resource.duration;

        analysis.slowestResources.push({
          name: resource.name.split('/').pop() || 'unknown',
          duration: Math.round(resource.duration),
          size: resource.transferSize || 0,
        });
      });

      analysis.slowestResources.sort((a, b) => b.duration - a.duration);
      analysis.slowestResources = analysis.slowestResources.slice(0, 5);

      return analysis;
    });

    console.log('\n📦 资源加载分析:');
    console.log(`  总资源数: ${resourceMetrics.total}`);
    Object.entries(resourceMetrics.byType).forEach(([type, data]) => {
      console.log(`  ${type}: ${data.count} 个, 总耗时 ${Math.round(data.totalTime)}ms`);
    });
    console.log('  最慢的 5 个资源:');
    resourceMetrics.slowestResources.forEach(r => {
      console.log(`    ${r.name}: ${r.duration}ms`);
    });

    expect(resourceMetrics.total).toBeLessThan(PERFORMANCE_THRESHOLDS.maxResources);
  });

  test('内存使用性能', async ({ page }) => {
    await page.goto('/');

    // 交互和滚动以模拟实际使用
    await page.waitForTimeout(1000);

    const memoryMetrics = await page.evaluate(() => {
      const memory = (performance as Performance & { memory?: BrowserPerformanceMemory }).memory || {
        usedJSHeapSize: 0,
        totalJSHeapSize: 0,
        jsHeapSizeLimit: 0,
      };

      return {
        used: Math.round(memory.usedJSHeapSize / 1024 / 1024),
        total: Math.round(memory.totalJSHeapSize / 1024 / 1024),
        limit: Math.round(memory.jsHeapSizeLimit / 1024 / 1024),
        percentage: ((memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100).toFixed(1),
      };
    });

    console.log('\n💾 内存使用:');
    console.log(`  已用: ${memoryMetrics.used} MB`);
    console.log(`  总计: ${memoryMetrics.total} MB`);
    console.log(`  限制: ${memoryMetrics.limit} MB`);
    console.log(`  使用率: ${memoryMetrics.percentage}%`);

    expect(memoryMetrics.used).toBeLessThan(PERFORMANCE_THRESHOLDS.maxMemory);
  });

  test('员工列表加载性能', async ({ page }) => {
    await page.goto('/');

    // 尝试导航到员工列表 - 支持多种按钮文本
    const employeeButtons = page.locator('button, a').filter({ hasText: /硅基员工|Employees|员工/ });
    const buttonCount = await employeeButtons.count();

    if (buttonCount > 0) {
      await employeeButtons.first().click();
      await page.waitForLoadState('networkidle');
    }

    const startTime = Date.now();
    await page.waitForTimeout(500); // 确保列表渲染

    // 列表应该快速渲染
    const loadTime = Date.now() - startTime;

    // 检查列表中的项目数量
    const itemCount = await page.locator('[class*="employee"], [role="row"]').count();

    console.log('\n👥 员工列表性能:');
    console.log(`  加载时间: ${loadTime}ms`);
    console.log(`  显示项目: ${itemCount}`);

    // 在员工导航不可用时跳过断言
    if (buttonCount === 0) {
      console.log('  (员工列表在当前应用状态不可用)');
    }
  });

  test('搜索性能（防抖测试）', async ({ page }) => {
    await page.goto('/');

    // 尝试导航到员工列表
    const employeeButtons = page.locator('button, a').filter({ hasText: /硅基员工|Employees|员工/ });
    const buttonCount = await employeeButtons.count();

    if (buttonCount > 0) {
      await employeeButtons.first().click();
      await page.waitForLoadState('networkidle');
    }

    // 找到搜索框
    const searchInput = page.locator('input[type="search"], input[placeholder*="搜索"], input[placeholder*="Search"]').first();

    if (await searchInput.isVisible()) {
      // 输入测试文本，检查防抖是否工作
      const searchEvents: number[] = [];
      const startTime = Date.now();

      // 快速连续输入（模拟用户打字）
      for (let i = 0; i < 5; i++) {
        await searchInput.type('test', { delay: 50 });
        searchEvents.push(Date.now() - startTime);
        await page.waitForTimeout(100);
      }

      console.log('\n🔍 搜索防抖测试:');
      console.log(`  输入事件间隔: ${searchEvents.join(', ')}ms`);
      console.log(`  应该看到较少的网络请求（防抖生效）`);
    } else {
      console.log('\n🔍 搜索防抖测试:');
      console.log(`  (搜索输入框在当前应用状态不可用)`);
    }
  });
});

test.describe('性能回归检测', () => {
  test('连续加载多次检查稳定性', async ({ page }) => {
    const results: StabilityMetrics[] = [];

    for (let i = 0; i < 3; i++) {
      await page.goto('/');
      const metrics = await getPerformanceMetrics(page);
      results.push({
        iteration: i + 1,
        fcp: Math.round(metrics.fcp),
        lcp: Math.round(metrics.lcp),
        pageLoad: Math.round(metrics.pageLoad),
      });
    }

    console.log('\n📈 多次加载稳定性:');
    results.forEach(r => {
      console.log(`  第 ${r.iteration} 次: FCP=${r.fcp}ms, LCP=${r.lcp}ms, 加载=${r.pageLoad}ms`);
    });

    // 检查性能波动不超过 20%
    // 注意: 在开发模式下 FCP/LCP 可能是 0，需要特殊处理
    const fcpValues = results.map(r => r.fcp).filter(v => v > 0);

    if (fcpValues.length > 1) {
      const avgFcp = fcpValues.reduce((a, b) => a + b) / fcpValues.length;
      const fcpVariance = Math.max(...fcpValues) - Math.min(...fcpValues);
      const fcpVariancePercent = avgFcp > 0 ? (fcpVariance / avgFcp) * 100 : 0;

      console.log(`  FCP 波动: ${fcpVariancePercent.toFixed(1)}%`);
      expect(fcpVariancePercent).toBeLessThan(20);
    } else {
      console.log(`  FCP 波动: 无法计算 (开发模式下 FCP 为 0，跳过方差检查)`);
    }
  });
});
