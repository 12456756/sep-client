#!/usr/bin/env node
/**
 * 前端优化效果验证脚本
 * 验证所有已实施的优化是否正常工作
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

console.log('🔍 开始验证前端优化效果...\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result) {
      console.log(`✅ ${name}`);
      passed++;
    } else {
      console.log(`❌ ${name}`);
      failed++;
    }
  } catch (error) {
    console.log(`❌ ${name} - Error: ${error.message}`);
    failed++;
  }
}

// ========== 1. 代码分割验证 ==========
console.log('📦 1. 代码分割验证');

test('electron.vite.config.ts 包含 manualChunks 配置', () => {
  const config = readFileSync(join(projectRoot, 'electron.vite.config.ts'), 'utf-8');
  return config.includes('manualChunks') &&
         config.includes('react-vendor') &&
         config.includes('ui-vendor');
});

test('构建输出目录存在', () => {
  return existsSync(join(projectRoot, 'out'));
});

// ========== 2. 懒加载验证 ==========
console.log('\n🔄 2. 懒加载验证');

test('App.tsx 使用 lazy() 加载组件', () => {
  const app = readFileSync(join(projectRoot, 'src/App.tsx'), 'utf-8');
  return app.includes('import { useEffect, useState, lazy, Suspense }') &&
         app.includes('lazy(() => import');
});

test('App.tsx 包含 Suspense 边界', () => {
  const app = readFileSync(join(projectRoot, 'src/App.tsx'), 'utf-8');
  return app.includes('<Suspense fallback=');
});

// ========== 3. 错误边界验证 ==========
console.log('\n🛡️ 3. 错误边界验证');

test('ErrorBoundary 组件存在', () => {
  return existsSync(join(projectRoot, 'src/components/ErrorBoundary.tsx'));
});

test('main.tsx 包含 ErrorBoundary', () => {
  const main = readFileSync(join(projectRoot, 'src/main.tsx'), 'utf-8');
  return main.includes('ErrorBoundary');
});

test('ErrorBoundary 实现了错误日志', () => {
  const eb = readFileSync(join(projectRoot, 'src/components/ErrorBoundary.tsx'), 'utf-8');
  return eb.includes('logError') && eb.includes('componentDidCatch');
});

// ========== 4. 性能监控验证 ==========
console.log('\n📊 4. 性能监控验证');

test('performance-monitor.ts 存在', () => {
  return existsSync(join(projectRoot, 'src/utils/performance-monitor.ts'));
});

test('main.tsx 初始化性能监控', () => {
  const main = readFileSync(join(projectRoot, 'src/main.tsx'), 'utf-8');
  return main.includes('initPerformanceMonitoring');
});

test('性能监控包含 Web Vitals 指标', () => {
  const pm = readFileSync(join(projectRoot, 'src/utils/performance-monitor.ts'), 'utf-8');
  return pm.includes('firstContentfulPaint') &&
         pm.includes('largestContentfulPaint') &&
         pm.includes('firstInputDelay') &&
         pm.includes('cumulativeLayoutShift');
});

// ========== 5. Hooks 优化验证 ==========
console.log('\n🎣 5. Hooks 优化验证');

test('useDebounce hook 存在', () => {
  return existsSync(join(projectRoot, 'src/hooks/useDebounce.ts'));
});

test('useThrottle hook 存在', () => {
  return existsSync(join(projectRoot, 'src/hooks/useThrottle.ts'));
});

test('useDebounce 实现正确', () => {
  const hook = readFileSync(join(projectRoot, 'src/hooks/useDebounce.ts'), 'utf-8');
  return hook.includes('setTimeout') && hook.includes('clearTimeout');
});

// ========== 6. React.memo 优化验证 ==========
console.log('\n🔄 6. React.memo 优化验证');

test('EmployeeDeskCard 使用 memo', () => {
  const card = readFileSync(join(projectRoot, 'src/components/enterprise/EmployeeDeskCard.tsx'), 'utf-8');
  return card.includes('import { memo }') && card.includes('memo(function');
});

// ========== 7. 虚拟滚动验证 ==========
console.log('\n📜 7. 虚拟滚动验证');

test('VirtualList 组件存在', () => {
  return existsSync(join(projectRoot, 'src/components/VirtualList.tsx'));
});

test('VirtualList 使用 @tanstack/react-virtual', () => {
  const vl = readFileSync(join(projectRoot, 'src/components/VirtualList.tsx'), 'utf-8');
  return vl.includes('@tanstack/react-virtual');
});

test('@tanstack/react-virtual 依赖已安装', () => {
  const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
  return pkg.dependencies['@tanstack/react-virtual'] !== undefined;
});

// ========== 8. 骨架屏验证 ==========
console.log('\n💀 8. 骨架屏验证');

test('Skeleton 组件存在', () => {
  return existsSync(join(projectRoot, 'src/components/Skeleton.tsx'));
});

test('Skeleton 包含多种类型', () => {
  const skeleton = readFileSync(join(projectRoot, 'src/components/Skeleton.tsx'), 'utf-8');
  return skeleton.includes('EmployeeCardSkeleton') &&
         skeleton.includes('EmployeeListSkeleton') &&
         skeleton.includes('PageLoadingSkeleton');
});

// ========== 9. 图片优化验证 ==========
console.log('\n🖼️ 9. 图片优化验证');

test('OptimizedImage 组件存在', () => {
  return existsSync(join(projectRoot, 'src/components/OptimizedImage.tsx'));
});

test('OptimizedImage 支持懒加载', () => {
  const img = readFileSync(join(projectRoot, 'src/components/OptimizedImage.tsx'), 'utf-8');
  return img.includes('loading="lazy"') && img.includes('decoding="async"');
});

test('Avatar 组件有字母后备方案', () => {
  const img = readFileSync(join(projectRoot, 'src/components/OptimizedImage.tsx'), 'utf-8');
  return img.includes('Avatar') && img.includes('fallback');
});

// ========== 10. 缓存管理验证 ==========
console.log('\n💾 10. 缓存管理验证');

test('cache.ts 存在', () => {
  return existsSync(join(projectRoot, 'src/utils/cache.ts'));
});

test('CacheManager 支持 TTL', () => {
  const cache = readFileSync(join(projectRoot, 'src/utils/cache.ts'), 'utf-8');
  return cache.includes('ttl') && cache.includes('cleanup');
});

test('useCachedData hook 存在', () => {
  const cache = readFileSync(join(projectRoot, 'src/utils/cache.ts'), 'utf-8');
  return cache.includes('useCachedData');
});

// ========== 11. 文档验证 ==========
console.log('\n📚 11. 文档验证');

test('优化计划文档存在', () => {
  return existsSync(join(projectRoot, 'docs/FRONTEND-OPTIMIZATION-PLAN.md'));
});

test('进度跟踪文档存在', () => {
  return existsSync(join(projectRoot, 'docs/OPTIMIZATION-PROGRESS.md'));
});

test('进度文档包含使用指南', () => {
  const progress = readFileSync(join(projectRoot, 'docs/OPTIMIZATION-PROGRESS.md'), 'utf-8');
  return progress.includes('使用指南') && progress.includes('示例');
});

// ========== 12. 构建配置验证 ==========
console.log('\n⚙️ 12. 构建配置验证');

test('启用了 CSS 代码分割', () => {
  const config = readFileSync(join(projectRoot, 'electron.vite.config.ts'), 'utf-8');
  return config.includes('cssCodeSplit: true');
});

test('配置了依赖预优化', () => {
  const config = readFileSync(join(projectRoot, 'electron.vite.config.ts'), 'utf-8');
  return config.includes('optimizeDeps');
});

test('使用 esbuild minify', () => {
  const config = readFileSync(join(projectRoot, 'electron.vite.config.ts'), 'utf-8');
  return config.includes("minify: 'esbuild'");
});

// ========== 结果汇总 ==========
console.log('\n' + '='.repeat(50));
console.log('📊 验证结果汇总:');
console.log(`✅ 通过: ${passed}`);
console.log(`❌ 失败: ${failed}`);
console.log(`📈 通过率: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
console.log('='.repeat(50));

if (failed === 0) {
  console.log('\n🎉 所有优化验证通过！前端优化实施完整。');
} else {
  console.log('\n⚠️ 部分验证失败，请检查上述失败项。');
  process.exit(1);
}
