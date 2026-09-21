# 前端视觉重设计 - 具体实现步骤

**目标**: 让首页和员工列表页看起来更专业、更高级  
**预计周期**: 2-3 周  
**版本**: v1 (P1 高优先级)

---

## 阶段 1: 首页重设计 (Phase 1.1) — 3 天

### 步骤 1.1.1: 新增 StatCard 组件

**文件**: `src/components/enterprise/StatCard.tsx` (新增)

```typescript
import { ReactNode } from 'react';

interface StatCardProps {
  title: string;
  value: number;
  subtitle?: string;
  icon?: ReactNode;
  color?: 'primary' | 'success' | 'warning' | 'danger';
  onClick?: () => void;
}

export function StatCard({ 
  title, 
  value, 
  subtitle, 
  icon, 
  color = 'primary',
  onClick 
}: StatCardProps) {
  return (
    <button
      type="button"
      className={`stat-card stat-card-${color}`}
      onClick={onClick}
    >
      {icon && <div className="stat-icon">{icon}</div>}
      <div className="stat-content">
        <div className="stat-value">{value}</div>
        <div className="stat-title">{title}</div>
        {subtitle && <div className="stat-subtitle">{subtitle}</div>}
      </div>
    </button>
  );
}
```

**CSS** (在 `src/styles/enterprise.css` 中添加):
```css
/* 统计卡片 */
.stat-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 24px;
  background: #ffffff;
  border: none;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  cursor: pointer;
  transition: all 200ms ease;
  min-height: 120px;
}

.stat-card:hover {
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.12);
  transform: translateY(-2px);
}

.stat-icon {
  flex-shrink: 0;
  font-size: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.stat-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
}

.stat-value {
  font-size: 32px;
  font-weight: 600;
  color: #20232b;
  line-height: 1;
}

.stat-title {
  font-size: 14px;
  color: #555b6e;
  font-weight: 500;
}

.stat-subtitle {
  font-size: 12px;
  color: #858a98;
}
```

---

### 步骤 1.1.2: 改进 HomePage 布局

**文件**: `src/pages/enterprise/HomePage.tsx` (修改)

**改动 1**: 导入新的 StatCard 组件
```typescript
import { StatCard } from '../../components/enterprise/StatCard';
```

**改动 2**: 替换 Figure 组件使用

从:
```tsx
<div className="ent-figures">
  <Figure label="公司员工总数" value={overview.totalEmployees} onClick={() => navigate({ name: 'employees', scope: 'all' })}>
    <GroupGlyph />
  </Figure>
  <Figure label="我拥有的员工" value={roster.length} alt onClick={() => navigate({ name: 'employees', scope: 'mine' })}>
    <PersonGlyph />
  </Figure>
</div>
```

改为:
```tsx
<div className="stat-cards-row">
  <StatCard 
    title="公司员工总数" 
    value={overview.totalEmployees}
    icon="👥"
    color="primary"
    onClick={() => navigate({ name: 'employees', scope: 'all' })}
  />
  <StatCard 
    title="我拥有的员工" 
    value={roster.length}
    icon="👤"
    color="primary"
    onClick={() => navigate({ name: 'employees', scope: 'mine' })}
  />
</div>
```

**改动 3**: 更新 CSS (在 `src/styles/enterprise.css`):
```css
/* 首页容器 */
.ent-home {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.ent-home-content {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 24px;
  flex: 1;
  overflow-y: auto;
}

/* 统计卡片行 */
.stat-cards-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
  width: 100%;
}

/* 员工墙区域 - 改进布局 */
.ent-wall {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 200px;
}

/* 移除旧的 Figure 样式 */
.ent-figures {
  display: none;
}
```

---

### 步骤 1.1.3: 改进员工卡片样式

**文件**: `src/styles/enterprise.css` (修改)

改进 EmployeeDeskCard 样式:
```css
/* 员工卡片基础 */
.ent-desk {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: #ffffff;
  border-radius: 10px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  transition: all 200ms ease;
}

.ent-desk:hover {
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.1);
  transform: translateY(-2px);
}

/* 打开按钮 */
.ent-desk-open {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
}

/* 卡片标题区 */
.ent-desk-id {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ent-desk-id strong {
  font-size: 14px;
  font-weight: 600;
  color: #20232b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 状态区 */
.ent-desk-state {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 工作统计 */
.ent-desk-load {
  font-size: 12px;
  color: #555b6e;
}

.ent-desk-load b {
  color: #20232b;
  font-weight: 600;
}

/* 进度条 */
.ent-desk-track {
  height: 4px;
  background: #e5e7eb;
  border-radius: 2px;
  overflow: hidden;
}

.ent-desk-track i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #6366f1, #818cf8);
  border-radius: 2px;
  transition: width 300ms ease;
}

.ent-desk-track i.full {
  background: linear-gradient(90deg, #10b981, #34d399);
  animation: none;
}
```

---

### 步骤 1.1.4: 改进派活框样式

**文件**: `src/styles/enterprise.css` (修改)

```css
/* ArrangeBar 容器 - 改为右下悬浮 */
.ent-arrange-bar {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 320px;
  z-index: 40;
  background: #ffffff;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  padding: 20px;
}

/* 响应式调整 */
@media (max-width: 960px) {
  .ent-arrange-bar {
    width: 280px;
    right: 16px;
    bottom: 16px;
  }
}

@media (max-width: 640px) {
  .ent-arrange-bar {
    width: calc(100% - 32px);
    right: 16px;
    left: 16px;
  }
}
```

---

### 步骤 1.1.5: 验收清单

- [ ] StatCard 组件创建并显示
- [ ] 首页统计卡片显示 2 个，宽度至少 280px
- [ ] 统计卡片有 hover 效果 (阴影 + 位移)
- [ ] 员工墙卡片显示正常，有 hover 效果
- [ ] 派活框在右下浮动
- [ ] 响应式: 1200px / 960px / 768px / 640px 都测试
- [ ] 无控制台错误
- [ ] TypeScript 类型检查通过

---

## 阶段 2: 员工列表改进 (Phase 1.2) — 2 天

### 步骤 1.2.1: 改进 EmployeeCard 卡片设计

**文件**: `src/components/enterprise/EmployeeCard.tsx` (修改)

改动: 提升卡片大小和信息显示

```typescript
// 在 card 模式下增加更多信息展示
export function EmployeeCard({ employee, onOpen, onChat, compact = false }: Props) {
  const enabled = employee.permissions.filter(item => item.enabled).length;

  if (compact) {
    // 保持原有紧凑模式
    ...
  }

  return (
    <article className={`ent-card ent-emp-card${employee.assignedToMe ? '' : ' off'}`}>
      <header className="ent-emp-card-header">
        <EmployeeFace seed={employee.id} size="lg" />
        <div className="ent-emp-card-meta-top">
          <strong title={employee.name} className="ent-emp-card-name">{employee.name}</strong>
          <AvailabilityChip value={employee.availability} />
        </div>
      </header>
      
      <p className="ent-emp-card-intro">{employee.intro}</p>
      
      <div className="ent-emp-card-skills">
        <span className="ent-skills-label">
          <Sparkles size={12} aria-hidden />
          擅长
        </span>
        <div className="ent-skills-tags">
          {employee.goodAt.slice(0, 3).map(item => (
            <span key={item} className="ent-tag">{item}</span>
          ))}
          {employee.goodAt.length > 3 ? (
            <span className="ent-tag">+{employee.goodAt.length - 3}</span>
          ) : null}
        </div>
      </div>
      
      <div className="ent-emp-card-footer">
        <div className="ent-emp-card-stats">
          <span title="已授权操作数">
            <ShieldCheck size={12} aria-hidden />
            {enabled}/{employee.permissions.length}
          </span>
          <span>
            {relativeTime(employee.lastWorkedAt)}
          </span>
        </div>
        <div className="ent-emp-card-actions">
          <button 
            type="button" 
            className="ent-btn primary sm" 
            onClick={() => onChat?.(employee.id)} 
            disabled={!employee.assignedToMe || !onChat || employee.availability === 'unavailable'}
          >
            <MessageSquareText size={13} aria-hidden />
            对话
          </button>
          <button 
            type="button" 
            className="ent-btn ghost sm" 
            onClick={() => onOpen(employee.id)}
          >
            详情
          </button>
        </div>
      </div>
    </article>
  );
}
```

---

### 步骤 1.2.2: 更新 EmployeeCard 样式

**文件**: `src/styles/enterprise.css` (修改)

```css
/* 员工卡片 - 改进版本 */
.ent-emp-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: #ffffff;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  transition: all 200ms ease;
  cursor: pointer;
}

.ent-emp-card:hover {
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.12);
  transform: translateY(-2px);
}

.ent-emp-card.off {
  opacity: 0.6;
}

/* 卡片头部 - 头像 + 名字 + 状态 */
.ent-emp-card-header {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.ent-emp-card-header .ent-face {
  flex-shrink: 0;
  width: 80px;
  height: 80px;
  border-radius: 10px;
  overflow: hidden;
}

.ent-emp-card-meta-top {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}

.ent-emp-card-name {
  font-size: 14px;
  font-weight: 600;
  color: #20232b;
  line-height: 1.2;
}

/* 简介 */
.ent-emp-card-intro {
  font-size: 12px;
  color: #555b6e;
  line-height: 1.4;
  margin: 0;
}

/* 技能部分 */
.ent-emp-card-skills {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ent-skills-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #858a98;
  font-weight: 500;
}

.ent-skills-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ent-tag {
  display: inline-block;
  padding: 4px 8px;
  background: #f0f1f8;
  border-radius: 6px;
  font-size: 12px;
  color: #555b6e;
  white-space: nowrap;
}

/* 卡片底部 - 统计 + 按钮 */
.ent-emp-card-footer {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 8px;
  padding-top: 12px;
  border-top: 1px solid #e5e7eb;
}

.ent-emp-card-stats {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: #858a98;
}

.ent-emp-card-stats span {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ent-emp-card-actions {
  display: flex;
  gap: 8px;
}

.ent-emp-card-actions .ent-btn {
  flex: 1;
  font-size: 12px;
  padding: 6px 12px;
}
```

---

### 步骤 1.2.3: 改进 EmployeesPage 工具栏

**文件**: `src/pages/enterprise/EmployeesPage.tsx` (修改)

改进工具栏样式:
```css
/* 工具栏 - 改为固定 + 优化布局 */
.ent-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: #ffffff;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
  position: sticky;
  top: 0;
  z-index: 10;
}

/* 搜索框 - 加大 */
.ent-find {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  max-width: 300px;
  padding: 8px 12px;
  background: #f7f8fc;
  border-radius: 8px;
  border: 1px solid transparent;
  transition: all 200ms ease;
}

.ent-find:focus-within {
  background: #ffffff;
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
}

.ent-find input {
  flex: 1;
  border: none;
  background: none;
  font-size: 14px;
  outline: none;
}

/* 分段按钮 */
.ent-segment {
  display: flex;
  gap: 0;
  background: #f7f8fc;
  padding: 2px;
  border-radius: 8px;
}

.ent-segment button {
  padding: 6px 12px;
  font-size: 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: 6px;
  transition: all 150ms ease;
}

.ent-segment button.active {
  background: #ffffff;
  color: #6366f1;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

/* 卡片网格 - 3 列 */
.ent-emp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  padding: 24px;
  overflow-y: auto;
  flex: 1;
}

/* 响应式 */
@media (max-width: 960px) {
  .ent-emp-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 640px) {
  .ent-emp-grid {
    grid-template-columns: 1fr;
  }
  
  .ent-toolbar {
    flex-wrap: wrap;
  }
  
  .ent-find {
    max-width: none;
    order: 1;
    flex-basis: 100%;
  }
}
```

---

### 步骤 1.2.4: 验收清单

- [ ] 员工卡片尺寸统一 (280px)，间距一致
- [ ] 卡片显示头像、名字、状态、简介、技能、统计、操作按钮
- [ ] 卡片有 hover 效果
- [ ] 工具栏固定在顶部，搜索/筛选/视图切换可用
- [ ] 卡片网格 3 列 (桌面)、2 列 (平板)、1 列 (手机)
- [ ] 响应式测试: 1200px / 960px / 768px / 640px
- [ ] 虚拟滚动仍然工作
- [ ] TypeScript 类型检查通过

---

## 阶段 3: 样式系统清理 (Phase 2.1) — 1 天

### 步骤 2.1.1: 统一 CSS 变量

**文件**: `src/styles/enterprise.css` (新增部分)

在文件开头添加完整的设计系统变量:
```css
:root {
  /* 颜色系统 */
  --ent-primary: #6366f1;
  --ent-primary-light: #818cf8;
  --ent-primary-dark: #4f46e5;
  
  --ent-success: #10b981;
  --ent-warning: #f59e0b;
  --ent-danger: #ef4444;
  --ent-neutral: #6b7280;
  
  /* 背景 */
  --ent-bg-primary: #ffffff;
  --ent-bg-secondary: #f7f8fc;
  --ent-bg-tertiary: #f0f1f8;
  
  /* 文字 */
  --ent-text-primary: #20232b;
  --ent-text-secondary: #555b6e;
  --ent-text-tertiary: #858a98;
  
  /* 间距 */
  --ent-space-xs: 4px;
  --ent-space-sm: 8px;
  --ent-space-md: 12px;
  --ent-space-lg: 16px;
  --ent-space-xl: 20px;
  --ent-space-2xl: 24px;
  --ent-space-3xl: 32px;
  
  /* 圆角 */
  --ent-radius-xs: 6px;
  --ent-radius-sm: 8px;
  --ent-radius-md: 10px;
  --ent-radius-lg: 12px;
  
  /* 阴影 */
  --ent-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --ent-shadow-md: 0 2px 8px rgba(0, 0, 0, 0.08);
  --ent-shadow-lg: 0 8px 16px rgba(0, 0, 0, 0.12);
  --ent-shadow-xl: 0 12px 24px rgba(0, 0, 0, 0.15);
  
  /* 过渡 */
  --ent-transition: all 200ms ease;
}
```

### 步骤 2.1.2: 应用变量

在各个 CSS 类中使用这些变量，例如:
```css
.stat-card {
  padding: var(--ent-space-xl);
  background: var(--ent-bg-primary);
  border-radius: var(--ent-radius-lg);
  box-shadow: var(--ent-shadow-md);
  transition: var(--ent-transition);
}

.stat-card:hover {
  box-shadow: var(--ent-shadow-lg);
}
```

---

## 提交和测试

### Git 提交

```bash
# 阶段 1: 首页重设计
git add src/components/enterprise/StatCard.tsx src/pages/enterprise/HomePage.tsx src/styles/enterprise.css
git commit -m "feat(home): redesign homepage with enlarged stat cards and improved layout

- Add StatCard component for prominent statistics display
- Improve employee wall card styling and hover effects  
- Move ArrangeBar to floating position in bottom-right
- Add CSS variables for design system consistency
- Improve responsive behavior at 1200px/960px/768px/640px breakpoints"

# 阶段 2: 员工列表改进
git add src/components/enterprise/EmployeeCard.tsx src/pages/enterprise/EmployeesPage.tsx src/styles/enterprise.css
git commit -m "feat(employees): redesign employee list with improved card design

- Enhance EmployeeCard with larger avatars (80px) and better layout
- Add skills section and stat information to cards
- Improve toolbar styling and sticky positioning
- Optimize responsive grid (3/2/1 columns by breakpoint)
- Increase visual hierarchy and professional appearance"

# 阶段 3: 样式统一
git add src/styles/enterprise.css
git commit -m "refactor(styles): consolidate design system variables

- Add comprehensive CSS variables for colors, spacing, shadows
- Replace hardcoded values with design system variables
- Improve consistency across components"
```

### 测试命令

```bash
# 开发模式 - 热重载
npm run dev

# 类型检查
npm run typecheck

# 代码规范检查
npm run lint

# 构建验证
npm run build
```

---

## 验收清单 (全阶段)

### 首页 (Phase 1.1)
- [ ] StatCard 组件创建并使用
- [ ] 统计卡片放大到 280px+
- [ ] 统计卡片有专业的 hover 效果
- [ ] 员工卡片显示流畅，有 hover 阴影
- [ ] 派活框浮在右下，不遮挡内容
- [ ] 所有响应式断点测试通过

### 员工列表 (Phase 1.2)
- [ ] 卡片尺寸统一（280px）
- [ ] 头像改为 80px（从之前更小）
- [ ] 显示名字、状态、简介、技能、统计
- [ ] 卡片 hover 效果优雅
- [ ] 工具栏固定，搜索突出
- [ ] 网格 3/2/1 列自适应正常

### 样式系统 (Phase 2.1)
- [ ] CSS 变量定义完整
- [ ] 主要组件使用变量
- [ ] 代码一致性提高
- [ ] 未来维护更容易

### 全局
- [ ] TypeScript 检查通过 ✅
- [ ] ESLint 通过 ✅
- [ ] 无控制台错误 ✅
- [ ] 性能无退化 (<100ms 首屏) ✅
- [ ] 响应式完整 (1200px/960px/768px/640px) ✅

---

## 时间规划

| 阶段 | 任务 | 预计 | 状态 |
|------|------|------|------|
| 1.1 | 首页重设计 | 3 天 | ⏳ 待实施 |
| 1.2 | 员工列表改进 | 2 天 | ⏳ 待实施 |
| 2.1 | 样式系统统一 | 1 天 | ⏳ 待实施 |
| 总计 | - | 6 天 | - |

---

**下一步**: 按照上述步骤实施，从 1.1.1 (StatCard 组件) 开始。
