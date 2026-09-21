# 自动化性能测试快速参考

## 📋 概述

自动化性能测试使用 **Playwright** 进行 E2E 性能测试，包括：

- ✅ Core Web Vitals 监控
- ✅ 资源加载分析
- ✅ 内存使用跟踪
- ✅ Web Workers 性能验证
- ✅ 图片优化验证
- ✅ 性能回归检测

---

## 🚀 快速开始

### 1. 运行性能测试

```bash
# 运行所有性能测试
npm run test:perf

# UI 模式（可视化）
npm run test:perf:ui

# 调试模式
npm run test:perf:debug

# 查看测试报告
npm run test:perf:report
```

### 2. 测试结构

```
tests/e2e/performance/
├── performance.spec.ts      # 基础性能指标测试
├── features.spec.ts         # Web Workers + 图片优化测试
└── ...
```

---

## 📊 性能基准配置

```typescript
const PERFORMANCE_THRESHOLDS = {
  fcp: 1800,           // First Contentful Paint (ms)
  lcp: 2500,           // Largest Contentful Paint (ms)
  ttfb: 800,           // Time to First Byte (ms)
  pageLoad: 3000,      // 页面加载时间 (ms)
  domReady: 1500,      // DOM 就绪时间 (ms)
  maxResources: 100,   // 最大资源数
  maxMemory: 100,      // 最大内存 (MB)
};
```

---

## 🧪 测试用例

### 基础性能测试

1. **首页加载性能**
   - 测试 FCP、LCP、TTFB
   - 验证页面加载时间
   - 检查资源数量

2. **资源加载性能**
   - 分析按资源类型的加载时间
   - 找出最慢的 5 个资源
   - 检查总资源数

3. **内存使用性能**
   - 监控 JS 堆内存使用
   - 计算内存使用率
   - 检查内存泄漏风险

4. **员工列表加载**
   - 测试列表页面加载
   - 检查虚拟滚动性能
   - 验证项目渲染

5. **搜索防抖测试**
   - 验证防抖功能工作
   - 测试搜索响应时间
   - 检查网络请求优化

### Web Workers 测试

1. **排序性能**
   - 测试大数据排序速度
   - 验证 Worker 处理效率
   - 确保 UI 不阻塞

2. **搜索性能**
   - 测试大数据搜索
   - 验证防抖 + Worker
   - 检查响应时间

### 图片优化测试

1. **格式和体积**
   - 检查响应式图片 (srcset)
   - 验证懒加载
   - 统计图片格式

2. **加载时间**
   - 测试平均加载时间
   - 找出最慢的图片
   - 验证现代格式加载

### 性能回归检测

1. **多次加载稳定性**
   - 3 次连续加载
   - 检查性能波动
   - 验证波动 < 20%

---

## 📈 解读测试输出

```
📊 首页性能指标:
  FCP: 1523ms (good)
  LCP: 2341ms (good)
  TTFB: 456ms (good)
  页面加载: 2876ms
  DOM就绪: 1289ms
  资源数: 67

📦 资源加载分析:
  总资源数: 67
  script: 12 个, 总耗时 1234ms
  stylesheet: 5 个, 总耗时 567ms
  最慢的 5 个资源:
    vendor-123.js: 456ms
    main.js: 345ms
    ...
```

### 性能等级

- 🟢 **Good**: 在目标范围内
- 🟡 **Needs Improvement**: 接近上限
- 🔴 **Poor**: 超过上限

---

## 🔧 自定义测试

### 修改性能基准

编辑 `tests/e2e/performance/performance.spec.ts`:

```typescript
const PERFORMANCE_THRESHOLDS = {
  fcp: 1800,    // 修改这些值
  lcp: 2500,
  // ...
};
```

### 添加新测试

在 `features.spec.ts` 中添加：

```typescript
test('自定义性能测试', async ({ page }) => {
  await page.goto('/');
  
  const startTime = Date.now();
  // 执行操作
  const duration = Date.now() - startTime;
  
  console.log(`操作耗时: ${duration}ms`);
  expect(duration).toBeLessThan(1000);
});
```

---

## 🔍 调试性能问题

### 启用调试模式

```bash
npm run test:perf:debug
```

### 查看屏幕录像

测试失败时会自动保存：
- 屏幕录像 (`video/`)
- 屏幕截图 (`screenshots/`)
- Trace 文件 (`traces/`)

### 分析性能数据

1. 运行测试并获取指标
2. 对比基准值
3. 识别性能下降
4. 优化相关代码
5. 重新运行验证

---

## 📋 CI/CD 集成

### GitHub Actions 示例

```yaml
name: Performance Tests

on: [push, pull_request]

jobs:
  performance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm install
      - run: npm run typecheck
      - run: npm run build
      - run: npm run test:perf
```

---

## 💡 最佳实践

1. **定期运行**
   - 每个 PR 前运行性能测试
   - 定期监控性能趋势
   - 建立性能基准线

2. **持续优化**
   - 监控 Core Web Vitals
   - 分析资源加载
   - 优化大文件

3. **团队协作**
   - 共享性能目标
   - 记录优化历史
   - 定期评审

4. **工具配置**
   - 使用合理的超时时间
   - 配置正确的网络条件
   - 保持一致的测试环境

---

## ✅ 验证清单

运行性能测试前，确保：

- [ ] 所有代码已提交
- [ ] 依赖已安装
- [ ] TypeScript 检查通过
- [ ] 构建成功
- [ ] 没有其他服务占用 5173 端口

---

## 📚 相关文档

- [PHASE3-FINAL-REPORT.md](./PHASE3-FINAL-REPORT.md) - Phase 3 完成报告
- [PHASE3-PROGRESS.md](./PHASE3-PROGRESS.md) - 进度跟踪
- [OPTIMIZATION-PROGRESS.md](./OPTIMIZATION-PROGRESS.md) - 总体优化进度

---

**通过自动化性能测试，确保每个 PR 都不会引入性能退化！** ✨
