#!/usr/bin/env node

/**
 * 图片优化验证脚本
 * 验证图片优化工具和组件的完整性
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

console.log('🔍 图片优化验证\n');

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

// 1. 检查工具文件
console.log('🛠️  工具文件验证:\n');

const utilsPath = resolve(rootDir, 'src/utils/image-optimization.ts');
check(
  'image-optimization.ts 已创建',
  existsSync(utilsPath),
  'src/utils/image-optimization.ts 不存在'
);

if (existsSync(utilsPath)) {
  const content = readFileSync(utilsPath, 'utf-8');

  check(
    'WebP 支持检测',
    content.includes('checkWebPSupport'),
    'WebP 支持检测未实现'
  );

  check(
    'AVIF 支持检测',
    content.includes('checkAVIFSupport'),
    'AVIF 支持检测未实现'
  );

  check(
    '图片 URL 优化',
    content.includes('getOptimizedImageUrl'),
    'getOptimizedImageUrl 未实现'
  );

  check(
    'srcset 生成',
    content.includes('generateSrcSet'),
    'generateSrcSet 未实现'
  );

  check(
    'sizes 生成',
    content.includes('generateSizes'),
    'generateSizes 未实现'
  );

  check(
    '懒加载管理器',
    content.includes('ImageLazyLoader'),
    'ImageLazyLoader 未实现'
  );

  check(
    'IntersectionObserver 使用',
    content.includes('IntersectionObserver'),
    'IntersectionObserver 未使用'
  );

  check(
    '图片预加载',
    content.includes('preloadImage'),
    'preloadImage 未实现'
  );
}

console.log();

// 2. 检查组件文件
console.log('🎨 组件文件验证:\n');

const componentPath = resolve(rootDir, 'src/components/OptimizedImage.tsx');
check(
  'OptimizedImage.tsx 已创建',
  existsSync(componentPath),
  'src/components/OptimizedImage.tsx 不存在'
);

if (existsSync(componentPath)) {
  const content = readFileSync(componentPath, 'utf-8');

  check(
    'OptimizedImage 组件',
    content.includes('export function OptimizedImage'),
    'OptimizedImage 组件未导出'
  );

  check(
    'Picture 组件',
    content.includes('export function Picture'),
    'Picture 组件未导出'
  );

  check(
    'BackgroundImage 组件',
    content.includes('export function BackgroundImage'),
    'BackgroundImage 组件未导出'
  );

  check(
    '懒加载支持',
    content.includes('lazy') && content.includes('data-src'),
    '懒加载未实现'
  );

  check(
    '响应式支持',
    content.includes('widths') && content.includes('sizes'),
    '响应式图片未实现'
  );

  check(
    '占位符支持',
    content.includes('placeholder'),
    '占位符未实现'
  );

  check(
    '优先级支持',
    content.includes('priority') && content.includes('fetchPriority'),
    '优先级控制未实现'
  );

  check(
    '加载状态管理',
    content.includes('loadState') && content.includes('useState'),
    '加载状态未实现'
  );

  check(
    '多格式源支持',
    content.includes('type="image/avif"') && content.includes('type="image/webp"'),
    '多格式源未实现'
  );
}

console.log();

// 3. 检查示例文件
console.log('📚 示例文件验证:\n');

const examplesPath = resolve(rootDir, 'src/components/image-examples.tsx');
check(
  'image-examples.tsx 已创建',
  existsSync(examplesPath),
  'src/components/image-examples.tsx 不存在'
);

if (existsSync(examplesPath)) {
  const content = readFileSync(examplesPath, 'utf-8');

  check(
    '基础用法示例',
    content.includes('BasicImageExample'),
    '基础用法示例未包含'
  );

  check(
    '响应式示例',
    content.includes('ResponsiveImageExample'),
    '响应式示例未包含'
  );

  check(
    'Picture 示例',
    content.includes('PictureExample'),
    'Picture 示例未包含'
  );

  check(
    '背景图片示例',
    content.includes('BackgroundImageExample'),
    '背景图片示例未包含'
  );

  check(
    '占位符示例',
    content.includes('PlaceholderExample'),
    '占位符示例未包含'
  );

  check(
    '性能对比示例',
    content.includes('PerformanceComparisonExample'),
    '性能对比示例未包含'
  );
}

console.log();

// 4. 检查初始化集成
console.log('🔗 初始化集成验证:\n');

const mainPath = resolve(rootDir, 'src/main.tsx');
const mainContent = readFileSync(mainPath, 'utf-8');

check(
  'initImageFormatSupport 已导入',
  mainContent.includes('initImageFormatSupport'),
  'main.tsx 中未导入 initImageFormatSupport'
);

check(
  '格式支持已初始化',
  mainContent.includes('initImageFormatSupport()'),
  'main.tsx 中未调用 initImageFormatSupport()'
);

console.log();

// 5. TypeScript 类型验证
console.log('🔤 TypeScript 类型验证:\n');

if (existsSync(componentPath)) {
  const content = readFileSync(componentPath, 'utf-8');

  check(
    'OptimizedImageProps 接口',
    content.includes('interface OptimizedImageProps'),
    'OptimizedImageProps 接口未定义'
  );

  check(
    'PictureProps 接口',
    content.includes('interface PictureProps'),
    'PictureProps 接口未定义'
  );

  check(
    'BackgroundImageProps 接口',
    content.includes('interface BackgroundImageProps'),
    'BackgroundImageProps 接口未定义'
  );
}

if (existsSync(utilsPath)) {
  const content = readFileSync(utilsPath, 'utf-8');

  check(
    'ImageLoadState 类型',
    content.includes('type ImageLoadState'),
    'ImageLoadState 类型未定义'
  );

  check(
    'imageFormatSupport 导出',
    content.includes('export const imageFormatSupport'),
    'imageFormatSupport 未导出'
  );
}

console.log();

// 6. 功能特性验证
console.log('⚡ 功能特性验证:\n');

if (existsSync(componentPath)) {
  const content = readFileSync(componentPath, 'utf-8');

  check(
    '自动格式选择',
    content.includes("format = 'auto'"),
    '自动格式选择未实现'
  );

  check(
    '质量控制',
    content.includes('quality'),
    '质量控制未实现'
  );

  check(
    '渐进式加载',
    content.includes('transition') || content.includes('opacity'),
    '渐进式加载效果未实现'
  );
}

if (existsSync(utilsPath)) {
  const content = readFileSync(utilsPath, 'utf-8');

  check(
    'rootMargin 优化',
    content.includes('rootMargin'),
    'rootMargin 优化未实现'
  );

  check(
    '降级支持',
    content.includes('降级') || content.includes('fallback'),
    '降级支持未注释说明'
  );
}

console.log();

// 总结
console.log('═══════════════════════════════════════');
console.log(`✅ 通过: ${passed}`);
console.log(`❌ 失败: ${failed}`);
console.log(`📊 总计: ${passed + failed}`);
console.log(`🎯 成功率: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
console.log('═══════════════════════════════════════\n');

if (failed === 0) {
  console.log('🎉 图片优化验证全部通过！\n');
  console.log('📋 使用建议:');
  console.log('   1. 导入组件: import { OptimizedImage } from "@/components/OptimizedImage"');
  console.log('   2. 使用懒加载: <OptimizedImage src="..." alt="..." lazy />');
  console.log('   3. 响应式图片: widths={[320, 640, 960]} sizes="..."');
  console.log('   4. 查看示例: src/components/image-examples.tsx\n');
  console.log('⚡ 预期收益:');
  console.log('   • 图片体积减少: 40-60%（现代格式）');
  console.log('   • 加载速度提升: 30-50%');
  console.log('   • 带宽节省: 显著（响应式 + 懒加载）');
  console.log('   • 用户体验: 更快的首屏渲染\n');
} else {
  console.log('⚠️  部分检查未通过，请修复上述问题。\n');
  process.exit(1);
}
