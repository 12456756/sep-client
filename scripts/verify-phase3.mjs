#!/usr/bin/env node

/**
 * Phase 3 优化验证脚本
 * 验证 Bundle 分析工具和性能监控组件
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

console.log('🔍 Phase 3 优化验证\n');

let passed = 0;
let failed = 0;

function check(name, condition, errorMsg) {
  if (condition) {
    console.log(`✅ ${name}`);
    passed++;
  } else {
    console.log(`❌ ${name}: ${errorMsg}`);
    failed++;
  }
}

// 1. 检查 Bundle 分析工具配置
console.log('📦 Bundle 分析工具验证:\n');

const configPath = resolve(rootDir, 'electron.vite.config.ts');
const configContent = readFileSync(configPath, 'utf-8');

check(
  'visualizer 插件已导入',
  configContent.includes("import { visualizer } from 'rollup-plugin-visualizer'"),
  'electron.vite.config.ts 中未找到 visualizer 导入'
);

check(
  'visualizer 插件已配置',
  configContent.includes('visualizer({') && configContent.includes('filename:'),
  'electron.vite.config.ts 中未配置 visualizer 插件'
);

check(
  'gzipSize 已启用',
  configContent.includes('gzipSize: true'),
  'gzipSize 未启用'
);

check(
  'brotliSize 已启用',
  configContent.includes('brotliSize: true'),
  'brotliSize 未启用'
);

const packageJsonPath = resolve(rootDir, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

check(
  'build:analyze 脚本已添加',
  packageJson.scripts['build:analyze'] !== undefined,
  'package.json 中未找到 build:analyze 脚本'
);

console.log();

// 2. 检查性能监控组件
console.log('📊 性能监控组件验证:\n');

const performanceMonitorPath = resolve(rootDir, 'src/components/PerformanceMonitor.tsx');
check(
  'PerformanceMonitor 组件已创建',
  existsSync(performanceMonitorPath),
  'src/components/PerformanceMonitor.tsx 不存在'
);

if (existsSync(performanceMonitorPath)) {
  const monitorContent = readFileSync(performanceMonitorPath, 'utf-8');

  check(
    '监控 FCP 指标',
    monitorContent.includes('fcp') || monitorContent.includes('FCP'),
    '未找到 FCP 监控'
  );

  check(
    '监控 LCP 指标',
    monitorContent.includes('lcp') || monitorContent.includes('LCP'),
    '未找到 LCP 监控'
  );

  check(
    '监控内存使用',
    monitorContent.includes('memory') || monitorContent.includes('Memory'),
    '未找到内存监控'
  );

  check(
    '支持最小化功能',
    monitorContent.includes('minimized') && monitorContent.includes('setMinimized'),
    '未找到最小化功能'
  );

  check(
    '支持位置配置',
    monitorContent.includes('position') && monitorContent.includes('top-left'),
    '未找到位置配置'
  );

  check(
    '性能等级评估',
    monitorContent.includes('getPerformanceLevel') || monitorContent.includes('good'),
    '未找到性能等级评估'
  );
}

console.log();

// 3. 检查 App.tsx 集成
console.log('🔗 应用集成验证:\n');

const appPath = resolve(rootDir, 'src/App.tsx');
const appContent = readFileSync(appPath, 'utf-8');

check(
  'PerformanceMonitor 已导入',
  appContent.includes("import { PerformanceMonitor } from './components/PerformanceMonitor'"),
  'App.tsx 中未导入 PerformanceMonitor'
);

check(
  'PerformanceMonitor 已使用',
  appContent.includes('<PerformanceMonitor'),
  'App.tsx 中未使用 PerformanceMonitor 组件'
);

check(
  '仅在开发环境显示',
  appContent.includes('import.meta.env.DEV') && appContent.includes('PerformanceMonitor'),
  '未限制为开发环境显示'
);

console.log();

// 4. 检查依赖安装
console.log('📦 依赖验证:\n');

const nodeModulesPath = resolve(rootDir, 'node_modules');
const visualizerPath = resolve(nodeModulesPath, 'rollup-plugin-visualizer');

check(
  'rollup-plugin-visualizer 已安装',
  existsSync(visualizerPath),
  'node_modules/rollup-plugin-visualizer 不存在'
);

console.log();

// 5. 检查构建输出
console.log('🏗️  构建验证:\n');

const outPath = resolve(rootDir, 'out/renderer');
if (existsSync(outPath)) {
  check(
    '构建输出存在',
    existsSync(resolve(outPath, 'index.html')),
    '构建输出不存在'
  );

  const assetsPath = resolve(outPath, 'assets');
  if (existsSync(assetsPath)) {
    check(
      'Vendor chunks 已分割',
      existsSync(resolve(assetsPath)) &&
      readFileSync(resolve(rootDir, 'electron.vite.config.ts'), 'utf-8').includes('manualChunks'),
      'Vendor chunks 未正确分割'
    );
  }
} else {
  console.log('ℹ️  构建输出不存在（运行 npm run build 生成）');
}

console.log();

// 6. 检查分析文件
console.log('📈 Bundle 分析文件验证:\n');

const analysisPath = resolve(rootDir, 'bundle-analysis.html');
if (existsSync(analysisPath)) {
  const stats = statSync(analysisPath);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

  check(
    'Bundle 分析文件已生成',
    stats.size > 0,
    'bundle-analysis.html 为空'
  );

  console.log(`   文件大小: ${sizeMB} MB`);
  console.log(`   生成时间: ${stats.mtime.toLocaleString()}`);
} else {
  console.log('ℹ️  Bundle 分析文件不存在（运行 npm run build 生成）');
}

console.log();

// 7. 文档验证
console.log('📚 文档验证:\n');

const docsPath = resolve(rootDir, 'docs');

check(
  'PHASE3-PLAN.md 已创建',
  existsSync(resolve(docsPath, 'PHASE3-PLAN.md')),
  'docs/PHASE3-PLAN.md 不存在'
);

check(
  'PHASE3-PROGRESS.md 已创建',
  existsSync(resolve(docsPath, 'PHASE3-PROGRESS.md')),
  'docs/PHASE3-PROGRESS.md 不存在'
);

check(
  'OPTIMIZATION-PROGRESS.md 已更新',
  readFileSync(resolve(docsPath, 'OPTIMIZATION-PROGRESS.md'), 'utf-8').includes('Phase 3'),
  'OPTIMIZATION-PROGRESS.md 中未包含 Phase 3 内容'
);

console.log();

// 总结
console.log('═══════════════════════════════════════');
console.log(`✅ 通过: ${passed}`);
console.log(`❌ 失败: ${failed}`);
console.log(`📊 总计: ${passed + failed}`);
console.log(`🎯 成功率: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
console.log('═══════════════════════════════════════\n');

if (failed === 0) {
  console.log('🎉 Phase 3 优化验证全部通过！\n');
  console.log('📋 下一步建议:');
  console.log('   1. 运行 npm run build:analyze 查看 Bundle 分析');
  console.log('   2. 运行 npm run dev 查看性能监控面板');
  console.log('   3. 继续实施 Web Workers 集成\n');
} else {
  console.log('⚠️  部分检查未通过，请修复上述问题。\n');
  process.exit(1);
}
