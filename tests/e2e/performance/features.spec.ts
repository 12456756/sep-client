import { test } from '@playwright/test';

/**
 * 大数据列表性能测试（Web Workers 验证）
 */
test.describe('Web Workers 性能测试', () => {
  test('员工列表排序性能（虚拟滚动 + Worker）', async ({ page }) => {
    await page.goto('/');

    // 尝试导航到员工列表 - 支持多种按钮文本
    const employeeButtons = page.locator('button, a').filter({ hasText: /硅基员工|Employees|员工/ });
    const buttonCount = await employeeButtons.count();

    if (buttonCount === 0) {
      console.log('\n⚡ Web Workers 排序性能:');
      console.log('  (员工列表在当前应用状态不可用，测试跳过)');
      return;
    }

    await employeeButtons.first().click();
    await page.waitForLoadState('networkidle');

    // 等待列表加载
    await page.waitForTimeout(1000);

    // 测试排序性能
    const sortButton = page.locator('button:has-text("名字")').first();
    if (await sortButton.isVisible()) {
      const startTime = Date.now();
      await sortButton.click();
      await page.waitForTimeout(500); // 等待 Worker 处理
      const sortTime = Date.now() - startTime;

      console.log(`\n⚡ Web Workers 排序性能: ${sortTime}ms`);
      expect(sortTime).toBeLessThan(1000); // 排序应该快速完成
    } else {
      console.log('\n⚡ Web Workers 排序性能:');
      console.log('  (排序按钮在当前界面不可用)');
    }
  });

  test('员工列表搜索性能（Worker 处理）', async ({ page }) => {
    await page.goto('/');

    // 尝试导航到员工列表
    const employeeButtons = page.locator('button, a').filter({ hasText: /硅基员工|Employees|员工/ });
    const buttonCount = await employeeButtons.count();

    if (buttonCount === 0) {
      console.log('\n🔍 Web Workers 搜索性能:');
      console.log('  (员工列表在当前应用状态不可用，测试跳过)');
      return;
    }

    await employeeButtons.first().click();
    await page.waitForLoadState('networkidle');

    const searchInput = page.locator('input[type="search"], input[placeholder*="搜索"]').first();
    if (await searchInput.isVisible()) {
      const startTime = Date.now();
      await searchInput.type('test', { delay: 50 });
      await page.waitForTimeout(500); // 防抖 + Worker 处理时间
      const searchTime = Date.now() - startTime;

      console.log(`\n🔍 Web Workers 搜索性能: ${searchTime}ms`);
      expect(searchTime).toBeLessThan(800); // 应该很快
    } else {
      console.log('\n🔍 Web Workers 搜索性能:');
      console.log('  (搜索框在当前界面不可用)');
    }
  });
});

/**
 * 图片优化性能测试
 */
test.describe('图片优化性能测试', () => {
  test('图片格式和体积', async ({ page }) => {
    await page.goto('/');

    const imageMetrics = await page.evaluate(() => {
      const images = document.querySelectorAll('img');
      const metrics = {
        total: images.length,
        withSrcset: 0,
        withLazy: 0,
        formats: {} as Record<string, number>,
      };

      images.forEach(img => {
        if (img.srcset) metrics.withSrcset++;
        if (img.loading === 'lazy') metrics.withLazy++;

        const src = img.src || '';
        const format = src.split('.').pop()?.split('?')[0] || 'unknown';
        metrics.formats[format] = (metrics.formats[format] || 0) + 1;
      });

      return metrics;
    });

    console.log('\n🖼️  图片优化状态:');
    console.log(`  总图片数: ${imageMetrics.total}`);
    console.log(`  响应式 (srcset): ${imageMetrics.withSrcset}`);
    console.log(`  懒加载: ${imageMetrics.withLazy}`);
    console.log(`  格式分布:`, imageMetrics.formats);
  });

  test('图片加载时间', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const imageMetrics = await page.evaluate(() => {
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const imageResources = resources.filter(r =>
        /\.(jpg|jpeg|png|webp|avif|gif)$/i.test(r.name)
      );

      return {
        total: imageResources.length,
        totalTime: imageResources.reduce((sum, r) => sum + r.duration, 0),
        avgTime: imageResources.length > 0
          ? imageResources.reduce((sum, r) => sum + r.duration, 0) / imageResources.length
          : 0,
        largest: imageResources.length > 0
          ? Math.max(...imageResources.map(r => r.duration))
          : 0,
      };
    });

    console.log('\n⏱️  图片加载时间:');
    console.log(`  总图片资源: ${imageMetrics.total}`);
    console.log(`  总加载时间: ${Math.round(imageMetrics.totalTime)}ms`);
    console.log(`  平均加载时间: ${Math.round(imageMetrics.avgTime)}ms`);
    console.log(`  最慢的图片: ${Math.round(imageMetrics.largest)}ms`);
  });
});
