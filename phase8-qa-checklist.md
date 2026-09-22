# Phase 8: 测试与打磨 QA 清单

## 测试执行日期
2026-09-22

---

## 一、视觉一致性检查

### 1.1 英雄区统一性
| 页面 | 高度 | 眉标 | 标题斜体 | 照片尺寸 | 状态 |
|------|------|------|---------|---------|------|
| HomePage (员工概览) | 240px | ✅ WORKSPACE | ✅ | 500x240px | ✅ |
| EmployeesPage | 160px | ✅ OUR TEAM | ✅ | 420x160px | ✅ |
| ArrangeWorkPage | - | - | - | - | N/A (会话界面) |
| WorkRecordsPage | 160px | ✅ WORK RECORDS | ✅ | 440x160px | ✅ |
| SkillsPage | 160px | ✅ KNOWLEDGE BASE | ✅ | 420x160px | ✅ |

**发现问题：**
- WorkRecordsPage 英雄区照片宽度 440px，其他页面 420px（不一致）

### 1.2 卡片样式统一性
| 组件 | 圆角 | 阴影 | 边框 | 悬停效果 | 状态 |
|------|------|------|------|---------|------|
| .ent-emp-card | var(--ent-radius) | var(--ent-shadow) | 1px var(--ent-line) | 上浮 3px + 阴影加深 | ✅ |
| .ent-skill-card | var(--ent-radius) | 0 2px 8px rgba | 1px var(--ent-line) | 上浮 2px + 边框 terracotta | ✅ |
| .ent-record | var(--ent-radius) | var(--ent-shadow) | 1px var(--ent-line) | 边框 terracotta + 阴影加深 | ✅ |
| .ent-worktile | var(--ent-radius) | var(--ent-shadow) | 1px var(--ent-line) | 边框 terracotta + 箭头显示 | ✅ |

**发现问题：**
- .ent-skill-card 阴影使用硬编码 rgba 值，其他用 CSS 变量（不一致）
- 悬停上浮距离不统一（2px vs 3px）

### 1.3 按钮样式统一性
| 变体 | 高度 | 圆角 | 字重 | 状态 |
|------|------|------|------|------|
| .ent-btn.primary | 38px | 999px | 500 | ✅ |
| .ent-btn.ghost | 38px | 999px | 500 | ✅ |
| .ent-btn.sm | 30px | 999px | 500 | ✅ |
| .ent-btn.danger | 38px | 999px | 500 | ✅ |

**状态：** ✅ 统一

### 1.4 间距与节奏
| 区域 | 标准间距 | 实际使用 | 状态 |
|------|---------|---------|------|
| 英雄区内边距 | 32px | 32px (横向) | ✅ |
| 卡片内边距 | 20-24px | 20-24px | ✅ |
| 卡片间距 | 16-20px | 16-20px | ✅ |
| 区块间距 | 24px | 24px | ✅ |

**状态：** ✅ 统一

---

## 二、响应式布局验证

### 2.1 断点测试（需在开发环境中实测）

| 页面 | 1200px | 1024px | 960px | 768px | 640px |
|------|--------|--------|-------|-------|-------|
| HomePage | 4列 + 侧边栏 | 待测试 | 待测试 | 待测试 | 待测试 |
| EmployeesPage | 4列 | 3列 | 2列 | 待测试 | 待测试 |
| WorkRecordsPage | 标准 | 待测试 | 英雄区缩小 | 待测试 | 竖向布局 |
| SkillsPage | 4列 | 2列 + 180px侧栏 | 待测试 | 横向导航 + 1列 | 待测试 |
| ArrangeWorkPage | 标准 | 待测试 | 待测试 | 待测试 | 待测试 |

**测试步骤：**
```bash
# 启动开发服务器
npm run dev

# 使用浏览器开发工具测试以下尺寸：
# - 1200x800 (标准)
# - 1024x768 (平板横屏)
# - 960x640 (紧凑笔记本)
# - 768x1024 (平板竖屏)
# - 640x960 (小窗口)
```

### 2.2 已知响应式问题
- [ ] WorkRecordsPage 英雄区照片在 960px 需要从 440px → 320px
- [ ] 所有页面在 640px 以下需验证文字不重叠、按钮不溢出

---

## 三、键盘导航检查

### 3.1 焦点顺序 (Tab 键遍历)

**HomePage:**
```
顶部导航 → Tab切换 → 员工卡片(1-12) → 侧边栏用户菜单
```
- [ ] 焦点顺序符合视觉流
- [ ] 所有交互元素可达
- [ ] 焦点可见（2px terracotta 描边）

**EmployeesPage:**
```
顶部导航 → 搜索框 → 角色筛选 → 团队筛选 → 视图切换 → 员工卡片/列表项
```
- [ ] 焦点顺序符合视觉流
- [ ] 搜索框焦点样式正确
- [ ] 筛选按钮焦点可见

**ArrangeWorkPage:**
```
顶部导航 → 模式切换 → 输入框 → 提交按钮 → 附加控件
```
- [ ] 焦点顺序符合视觉流
- [ ] 输入框焦点样式正确（光晕 + 描边）

**WorkRecordsPage:**
```
顶部导航 → 工作类型Tab → 状态Tab → 搜索框 → 记录卡片标题 → 卡片按钮
```
- [ ] 焦点顺序符合视觉流
- [ ] 双层 Tab 焦点样式正确
- [ ] 记录标题焦点可见

**SkillsPage:**
```
顶部导航 → 左侧分类导航 → 搜索框 → 刷新按钮 → 技能卡片按钮
```
- [ ] 焦点顺序符合视觉流
- [ ] 左侧导航焦点样式正确
- [ ] 卡片内按钮焦点可见

### 3.2 快捷键支持
- [ ] 顶部导航数字键 1-5 切换页面（如已实现）
- [ ] Esc 键关闭抽屉/弹窗
- [ ] Enter/Space 激活按钮和链接

### 3.3 焦点陷阱
- [ ] 模态弹窗打开时焦点锁定在弹窗内
- [ ] 抽屉打开时焦点锁定在抽屉内
- [ ] 关闭后焦点返回触发元素

---

## 四、无障碍语义检查

### 4.1 ARIA 角色和属性

| 组件 | 应有 ARIA | 实际 | 状态 |
|------|-----------|------|------|
| 顶部导航 | role="navigation" | 待验证 | ⏳ |
| Tab 控件 | role="tablist", role="tab", aria-selected | 部分实现 | ⚠️ |
| 搜索框 | aria-label="搜索" | 已实现 | ✅ |
| 筛选按钮组 | role="group" 或 role="radiogroup" | 待验证 | ⏳ |
| 模态弹窗 | role="dialog", aria-modal="true" | 待验证 | ⏳ |
| 状态提示 | role="status" 或 aria-live | 待验证 | ⏳ |

**需要补充的 ARIA 标记：**
```typescript
// HomePage Tab 切换
<div role="tablist" aria-label="工作台视图切换">
  <button role="tab" aria-selected={activeTab === 'overview'}>员工概览</button>
  <button role="tab" aria-selected={activeTab === 'org'}>组织架构</button>
</div>

// EmployeesPage 筛选按钮组
<div role="group" aria-label="按角色筛选员工">
  {/* 按钮 */}
</div>

// WorkRecordsPage 双层 Tab
<div role="tablist" aria-label="按工作类型筛选">
  {/* Tab 按钮 */}
</div>
```

### 4.2 语义化 HTML
- [ ] 使用 `<nav>` 包裹顶部导航
- [ ] 使用 `<main>` 包裹页面主内容
- [ ] 使用 `<article>` 包裹独立内容块（员工卡片、工作记录）
- [ ] 标题层级正确（h1 → h2 → h3）

### 4.3 图片和图标
- [ ] 装饰性图标添加 `aria-hidden="true"`
- [ ] 有意义的图标添加 `aria-label`
- [ ] 头像图片添加 `alt` 文本

---

## 五、Reduced Motion 验证

### 5.1 媒体查询覆盖

**已实现的页面：**
- ✅ SkillsPage (禁用卡片悬停动画、导航过渡)
- ✅ WorkRecordsPage (禁用记录卡片、详情展开、筛选按钮过渡)
- ✅ HomePage (禁用 Tab 过渡)
- ✅ EmployeesPage (禁用卡片悬停动画)

**测试步骤：**
```bash
# macOS 开启减少动态效果
# 系统设置 → 辅助功能 → 显示 → 减少动态效果

# 或在浏览器开发工具中模拟
# 开发工具 → 渲染 → Emulate CSS media feature prefers-reduced-motion
```

### 5.2 验证清单
- [ ] 悬停效果：只保留颜色/边框变化，取消位移和缩放
- [ ] 页面过渡：直接显示终态，不做淡入淡出
- [ ] 加载动画：禁用旋转和脉动效果
- [ ] 展开/折叠：直接切换高度，不做过渡动画

---

## 六、性能验证

### 6.1 大数据量场景

**EmployeesPage:**
- [ ] 100+ 员工时渲染流畅（使用 VirtualGrid）
- [ ] 搜索和筛选响应时间 < 100ms
- [ ] 切换视图不卡顿

**WorkRecordsPage:**
- [ ] 50+ 工作记录时滚动流畅
- [ ] 展开/折叠详情不阻塞主线程
- [ ] 搜索和筛选响应时间 < 100ms

**SkillsPage:**
- [ ] 50+ 技能时网格布局流畅
- [ ] 切换分类不卡顿

### 6.2 性能指标 (Chrome DevTools Performance)

**目标值：**
- FCP (First Contentful Paint) < 1.5s
- LCP (Largest Contentful Paint) < 2.5s
- FID (First Input Delay) < 100ms
- CLS (Cumulative Layout Shift) < 0.1

**测试步骤：**
```bash
# 1. 清空缓存
# 2. 打开 Chrome DevTools → Performance
# 3. 录制页面加载和交互
# 4. 分析火焰图，查找长任务 (> 50ms)
```

### 6.3 内存泄漏检查
- [ ] 切换页面后旧页面组件正确卸载
- [ ] 事件监听器正确清理
- [ ] 定时器和动画正确取消

---

## 七、动画调优

### 7.1 动画流畅度检查

| 动画 | 帧率目标 | 实际 | 缓动函数 | 状态 |
|------|---------|------|---------|------|
| 卡片悬停上浮 | 60fps | 待测试 | ease-out | ⏳ |
| Tab 切换 | 60fps | 待测试 | ease | ⏳ |
| 详情展开/折叠 | 60fps | 待测试 | cubic-bezier | ⏳ |
| 页面过渡 | 60fps | 待测试 | ease-out | ⏳ |

**测试工具：**
```bash
# Chrome DevTools → Rendering → Frame Rendering Stats
# 绿色 = 60fps，黄色 = 30-60fps，红色 = <30fps
```

### 7.2 动画时长一致性

| 动画类型 | 标准时长 | 实际使用 | 状态 |
|---------|---------|---------|------|
| 快速反馈 (悬停) | 140-180ms | 140-180ms | ✅ |
| 中等过渡 (展开) | 220-280ms | 220ms | ✅ |
| 页面切换 | 300-400ms | 待验证 | ⏳ |

### 7.3 动画性能优化
- [ ] 优先使用 `transform` 和 `opacity`（硬件加速）
- [ ] 避免动画 `width`、`height`、`margin`（触发 layout）
- [ ] 避免动画 `box-shadow`（除非必要）
- [ ] 使用 `will-change` 提示浏览器（但不滥用）

---

## 八、浏览器兼容性

### 8.1 目标浏览器

| 浏览器 | 版本 | 测试状态 |
|--------|------|---------|
| Chrome/Edge | 最新 3 个版本 | ⏳ |
| Safari | 最新 2 个版本 | ⏳ |
| Firefox | 最新 3 个版本 | ⏳ |

### 8.2 CSS 特性兼容性
- [ ] CSS Grid (IE11 不支持，但已不在目标内)
- [ ] CSS Custom Properties (广泛支持)
- [ ] backdrop-filter (Safari 需要 -webkit- 前缀)
- [ ] aspect-ratio (Chrome 88+, Safari 15+)

---

## 九、回归测试

### 9.1 核心用户流程

**流程 1: 查看员工并安排工作**
1. [ ] 进入首页，看到员工概览
2. [ ] 点击员工卡片，查看详情
3. [ ] 点击「安排工作」，进入安排页
4. [ ] 选择对话式模式，输入工作内容
5. [ ] 提交工作，跳转到工作记录

**流程 2: 筛选员工**
1. [ ] 进入硅基员工页
2. [ ] 使用角色筛选，看到正确结果
3. [ ] 使用搜索框，实时过滤
4. [ ] 切换列表视图，布局正确

**流程 3: 查看工作记录**
1. [ ] 进入工作记录页
2. [ ] 使用工作类型筛选（对话式/自动编排/手动编排）
3. [ ] 使用状态筛选（全部/进行中/已完成/未完成）
4. [ ] 展开记录详情，查看过程和结果
5. [ ] 复制为新工作

**流程 4: 浏览技能库**
1. [ ] 进入技能库页
2. [ ] 点击左侧分类导航（Skills/Prompts/Agents）
3. [ ] 使用搜索框筛选技能
4. [ ] 点击技能卡片，查看详情
5. [ ] 返回列表

---

## 十、已知问题和待修复项

### 高优先级 🔴
1. **WorkRecordsPage 英雄区照片宽度不一致**
   - 当前：440px
   - 应改为：420px（与其他页面统一）
   - 文件：`src/styles/enterprise.css` line 716

2. **SkillsPage 卡片阴影使用硬编码值**
   - 当前：`0 2px 8px rgb(0 0 0 / 0.04)`
   - 应改为：`var(--ent-shadow)`
   - 文件：`src/styles/skills.css` line 175

### 中优先级 🟡
3. **Tab 控件缺少完整 ARIA 标记**
   - 需要添加 `role="tablist"`, `role="tab"`, `aria-selected`
   - 影响页面：HomePage, WorkRecordsPage
   - 文件：`src/pages/enterprise/HomePage.tsx`, `src/pages/enterprise/WorkRecordsPage.tsx`

4. **顶部导航缺少 `role="navigation"`**
   - 文件：`src/components/enterprise/AppTopNav.tsx`（如存在）

### 低优先级 🟢
5. **悬停上浮距离不统一**
   - 员工卡片：3px
   - 技能卡片：2px
   - 建议：统一为 2px（更精致）

---

## 十一、测试执行记录

### 视觉一致性 - 执行时间：待定
- [ ] 英雄区高度和照片尺寸
- [ ] 卡片样式和悬停效果
- [ ] 按钮样式和状态
- [ ] 间距和节奏

### 响应式布局 - 执行时间：待定
- [ ] 1200px 标准尺寸
- [ ] 1024px 平板横屏
- [ ] 960px 紧凑笔记本
- [ ] 768px 平板竖屏
- [ ] 640px 小窗口

### 键盘导航 - 执行时间：待定
- [ ] 所有页面焦点顺序
- [ ] 焦点可见性
- [ ] 快捷键支持

### 无障碍语义 - 执行时间：待定
- [ ] ARIA 角色和属性
- [ ] 语义化 HTML
- [ ] 图片和图标 alt 文本

### Reduced Motion - 执行时间：待定
- [ ] 所有页面动画禁用
- [ ] 只保留颜色/边框变化

### 性能验证 - 执行时间：待定
- [ ] 大数据量场景
- [ ] 性能指标测量
- [ ] 内存泄漏检查

### 动画调优 - 执行时间：待定
- [ ] 动画流畅度
- [ ] 动画时长一致性
- [ ] 性能优化检查

### 浏览器兼容性 - 执行时间：待定
- [ ] Chrome/Edge
- [ ] Safari
- [ ] Firefox

### 回归测试 - 执行时间：待定
- [ ] 核心用户流程 1-4

---

## 十二、最终检查清单

### 代码质量
- [ ] TypeScript 类型检查通过 (`npm run typecheck`)
- [ ] ESLint 检查通过 (`npm run lint`)
- [ ] 没有 console.log/console.error 残留
- [ ] 没有 TODO/FIXME 注释残留

### 文件整理
- [ ] 删除未使用的 CSS 类
- [ ] 删除未使用的组件
- [ ] 删除测试用的临时文件
- [ ] 更新相关文档

### Git 提交
- [ ] 所有更改已提交
- [ ] Commit message 符合规范
- [ ] 分支命名清晰

---

## 签名

**QA 执行人：** Claude Opus 4.8  
**执行日期：** 2026-09-22  
**Phase 8 状态：** 🔄 进行中

**下一步行动：**
1. 修复高优先级问题（照片宽度、卡片阴影）
2. 在开发环境中执行响应式布局测试
3. 补充 ARIA 标记（Tab 控件、顶部导航）
4. 运行性能 profiling
5. 执行回归测试
6. 最终代码清理和文档更新
