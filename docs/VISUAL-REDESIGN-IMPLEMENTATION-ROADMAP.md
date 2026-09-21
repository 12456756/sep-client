# 前端视觉重设计 - 实现路线图

**创建日期**: 2026-09-21  
**目标**: 三个页面从当前风格升级为专业高级设计  
**预计周期**: 2-3 周分阶段交付

---

## 📋 项目范围

### 涉及的页面和组件

| 页面 | 组件文件 | 优先级 | 预计工作量 |
|------|---------|--------|----------|
| HomePage | `src/pages/enterprise/HomePage.tsx` | 🔴 P1 | 3 天 |
| EmployeesPage | `src/pages/enterprise/EmployeesPage.tsx` | 🔴 P1 | 2 天 |
| OrganizationPage | `src/pages/enterprise/OrganizationPage.tsx` | 🟡 P2 | 3 天 |
| 样式系统 | `src/styles/enterprise.css` + `src/index.css` | 🟡 P2 | 2 天 |

### 涉及的核心资源

```
src/
├── pages/enterprise/
│   ├── HomePage.tsx              ← P1 改进
│   ├── EmployeesPage.tsx         ← P1 改进
│   └── OrganizationPage.tsx      ← P2 改进
├── components/enterprise/
│   ├── employee-card/            ← 新增组件
│   ├── stat-card/                ← 新增组件
│   ├── department-card/          ← 新增组件
│   └── quick-assign-box/         ← 新增组件
└── styles/
    ├── enterprise.css            ← 扩充变量
    ├── components/               ← 新增组件样式
    └── index.css                 ← 清理/合并
```

---

## 🔴 第一阶段：P1 高优先级 (第 1-2 周)

### Phase 1.1: 首页 (HomePage) 重设计 — 3 天

#### 目标状态

```
顶部 (40% 高度):
┌─────────────────────────────────────┐
│ 统计卡片 (放大)                      │
│ • 公司员工总数: 2                   │
│ • 我拥有的员工: 2                   │
│ • 进度条/图表                       │
└─────────────────────────────────────┘

中部 (50% 高度):
┌─────────────────────────────────────┐
│ 【员工墙】 3-4 列网格               │
│ ┌─────┐ ┌─────┐ ┌─────┐           │
│ │员工 │ │员工 │ │员工 │           │
│ │卡片 │ │卡片 │ │卡片 │           │
│ └─────┘ └─────┘ └─────┘           │
└─────────────────────────────────────┘

右下 (悬浮):
┌─────────────────────┐
│ 快速派活框          │
│ [输入] [派出]       │
└─────────────────────┘
```

#### 代码变更清单

**1. 新增组件: StatCard.tsx**
```typescript
// src/components/enterprise/stat-card/StatCard.tsx
interface StatCardProps {
  title: string;
  value: number;
  icon?: string;
  max?: number;  // for progress bar
  color?: 'primary' | 'success' | 'warning';
}

export function StatCard({ title, value, icon, max, color }: StatCardProps) {
  // 大卡片设计 (320px width, gradient background, shadow)
  // 显示数值、标题、可选进度条
  // 支持 hover 效果
}
```

**2. 改进组件: EmployeeCard.tsx (从首页卡片提取)**
```typescript
// src/components/enterprise/employee-card/EmployeeCard.tsx
interface EmployeeCardProps {
  employee: EmployeeData;
  size?: 'small' | 'medium' | 'large';
  showStats?: boolean;
}

export function EmployeeCard({ employee, size = 'medium', showStats }: EmployeeCardProps) {
  // 抽象原 HomePage 中的员工卡片
  // 统一卡片尺寸和样式
  // 支持响应式大小
}
```

**3. 改进页面: HomePage.tsx**

改动要点：
- 用 `<StatCard>` 替换现有的统计小卡片
- 提取员工卡片到 `<EmployeeCard>` 组件
- 用 CSS Grid 改进布局（3-4 列响应式）
- 派活框改为悬浮位置（fixed/sticky）
- 调整内边距和间距

代码结构示意：
```tsx
export function HomePage() {
  return (
    <div className="homepage-container">
      {/* 顶部: 统计卡片 */}
      <section className="stat-section">
        <StatCard title="公司员工总数" value={2} icon="👥" max={10} />
        <StatCard title="我拥有的员工" value={2} icon="👤" max={10} />
      </section>

      {/* 中部: 员工墙网格 */}
      <section className="employee-wall">
        <div className="employee-grid">
          {employees.map(emp => (
            <EmployeeCard key={emp.id} employee={emp} size="medium" showStats />
          ))}
        </div>
      </section>

      {/* 右下: 悬浮派活框 */}
      <section className="quick-assign-floating">
        <QuickAssignBox />
      </section>
    </div>
  );
}
```

#### CSS 新增

```css
/* 首页容器 */
.homepage-container {
  display: flex;
  flex-direction: column;
  gap: 32px;
  padding: 24px;
  height: 100%;
  overflow-y: auto;
}

/* 统计卡片部分 */
.stat-section {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 20px;
  margin-bottom: 16px;
}

/* 员工墙网格 */
.employee-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 20px;
  flex-grow: 1;
}

/* 悬浮派活框 */
.quick-assign-floating {
  position: fixed;
  bottom: 32px;
  right: 32px;
  width: 320px;
  z-index: 40;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}
```

#### 测试清单

- [ ] 统计卡片正确显示数值和标题
- [ ] 员工卡片 3-4 列自适应显示
- [ ] 派活框在窗口调整时保持可见
- [ ] 响应式: 1200px+ / 960px / <768px
- [ ] Hover 效果流畅
- [ ] 信息不被截断或重叠

---

### Phase 1.2: 员工列表 (EmployeesPage) 改进 — 2 天

#### 目标状态

```
顶部工具栏:
┌──────────────────────────────────┐
│ 🔍 [搜索框] [筛选] [视图切换]     │
└──────────────────────────────────┘

卡片网格 (3 列):
┌─────────────┬─────────────┬─────────┐
│ ┌─────────┐ │ ┌─────────┐ │┌─────┐ │
│ │ 头像    │ │ │ 头像    │ ││头像 │ │
│ │ 80x80   │ │ │ 80x80   │ ││80x80│ │
│ └─────────┘ │ └─────────┘ │└─────┘ │
│             │             │        │
│ 名字        │ 名字        │名字   │
│ 职位        │ 职位        │职位   │
│ 状态 ●      │ 状态 ●      │状态 ● │
│             │             │        │
│ 擅长: 标签  │ 擅长: 标签  │擅长:  │
│ [聊] [详情] │ [聊] [详情] │[聊]   │
└─────────────┴─────────────┴────────┘
```

#### 代码变更清单

**1. 改进组件: EmployeesPage.tsx**

改动要点：
- 工具栏 (搜索、筛选) 固定在顶部
- 卡片网格改为 3 列，间距统一
- 卡片内容优化（大头像、清晰状态、技能标签）
- 按钮区域更紧凑

```tsx
export function EmployeesPage() {
  return (
    <div className="employees-container">
      {/* 工具栏 */}
      <div className="toolbar-sticky">
        <SearchBox onChange={onSearch} />
        <FilterButton onClick={onFilter} />
        <ViewToggle view={view} onChange={setView} />
      </div>

      {/* 卡片网格 */}
      <div className="employee-grid-3col">
        {employees.map(emp => (
          <EmployeeCard 
            key={emp.id} 
            employee={emp} 
            size="large"
            showSkills
            showStatus
          />
        ))}
      </div>
    </div>
  );
}
```

#### CSS 新增

```css
.employees-container {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.toolbar-sticky {
  display: flex;
  gap: 12px;
  padding: 16px;
  background: #ffffff;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
  position: sticky;
  top: 0;
  z-index: 10;
}

.employee-grid-3col {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 20px;
  padding: 24px;
  overflow-y: auto;
  flex: 1;
}

/* 响应式: 小屏幕改为 2 列 */
@media (max-width: 960px) {
  .employee-grid-3col {
    grid-template-columns: repeat(2, 1fr);
  }
}

/* 响应式: 极小屏幕改为 1 列 */
@media (max-width: 640px) {
  .employee-grid-3col {
    grid-template-columns: 1fr;
  }
}
```

#### 测试清单

- [ ] 卡片网格显示 3 列 (桌面)、2 列 (平板)、1 列 (手机)
- [ ] 工具栏始终可见，搜索可用
- [ ] 员工卡片显示头像、名字、职位、状态、技能
- [ ] 按钮区域响应式排列
- [ ] 虚拟滚动仍然工作 (如果已启用)

---

## 🟡 第二阶段：P2 中优先级 (第 2-3 周)

### Phase 2.1: 样式系统统一 — 2 天

#### 目标

合并 `index.css` 和 `enterprise.css`，建立单一的设计系统。

#### 任务清单

- [ ] 从 `enterprise.css` 提取所有 CSS 变量
- [ ] 在 `enterprise.css` 中定义完整的设计系统
- [ ] 删除 `index.css` 中的重复定义
- [ ] 添加卡片、按钮、输入框等通用组件样式
- [ ] 添加深色模式支持 (可选)

---

### Phase 2.2: 组织架构页面重设计 — 3 天

#### 目标

添加树状结构展示 + 改进部门卡片网格。

#### 任务清单

- [ ] 新增 `TreeView` 组件展示公司/部门/员工层级
- [ ] 新增 `DepartmentCard` 组件
- [ ] 改进页面布局（左树右网格或上树下卡片）
- [ ] 集成搜索/筛选功能

---

## 💻 实现顺序

### 周 1 (立即开始)

1. **Day 1-2**: StatCard 组件开发 + EmployeeCard 提取
2. **Day 3-4**: HomePage 重设计 + 样式调整
3. **Day 5**: EmployeesPage 改进

### 周 2

4. **Day 1-2**: 样式系统统一
5. **Day 3-5**: OrganizationPage 重设计

### 周 3 (选做)

6. **交互和动画优化**
7. **响应式调整**
8. **无障碍改进**

---

## 📐 设计规范

### 卡片设计

```css
/* 卡片基础 */
--ent-card-padding: 20px;
--ent-card-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
--ent-card-shadow-hover: 0 8px 16px rgba(0, 0, 0, 0.12);
--ent-card-radius: 12px;
--ent-card-transition: all 200ms ease;

/* 应用 */
.card {
  background: #ffffff;
  border-radius: var(--ent-card-radius);
  box-shadow: var(--ent-card-shadow);
  transition: var(--ent-card-transition);
  padding: var(--ent-card-padding);
}

.card:hover {
  box-shadow: var(--ent-card-shadow-hover);
  transform: translateY(-2px);
}
```

### 颜色系统

```css
/* 主色系 */
--ent-primary: #6366f1;      /* 蓝紫 */
--ent-primary-light: #818cf8; /* 浅紫 */
--ent-primary-dark: #4f46e5;  /* 深紫 */

/* 状态色 */
--ent-success: #10b981;       /* 绿 */
--ent-warning: #f59e0b;       /* 琥珀 */
--ent-danger: #ef4444;        /* 红 */
--ent-neutral: #6b7280;       /* 灰 */

/* 背景 */
--ent-bg-primary: #ffffff;
--ent-bg-secondary: #f7f8fc;
--ent-bg-tertiary: #f0f1f8;

/* 文字 */
--ent-text-primary: #20232b;
--ent-text-secondary: #555b6e;
--ent-text-tertiary: #858a98;
```

### 间距系统

```css
--ent-space-xs: 4px;
--ent-space-sm: 8px;
--ent-space-md: 12px;
--ent-space-lg: 16px;
--ent-space-xl: 20px;
--ent-space-2xl: 24px;
--ent-space-3xl: 32px;
```

---

## ✅ 验收标准

### 首页

- ✅ 统计卡片明显放大（至少 300px 宽）
- ✅ 员工卡片 3-4 列自适应显示
- ✅ 派活框浮在右下，不遮挡内容
- ✅ 整体信息密度合理，不拥挤
- ✅ 响应式工作正常

### 员工列表

- ✅ 卡片统一 280px 宽，间距一致
- ✅ 显示头像、名字、职位、状态、技能、操作按钮
- ✅ 3 列网格 (桌面)、2 列 (平板)、1 列 (手机)
- ✅ 工具栏固定，搜索/筛选可用

### 整体

- ✅ 所有页面风格一致
- ✅ TypeScript 类型检查通过
- ✅ 无控制台错误
- ✅ 性能无退化 (首屏 <100ms)

---

## 📊 预期改进

| 指标 | 当前 | 改进后 |
|------|------|--------|
| 首屏信息展示 | 稀疏 | 合理紧凑 |
| 卡片视觉层级 | 平坦 | 清晰有深度 |
| 专业度评级 | ⭐⭐ | ⭐⭐⭐⭐ |
| 响应式完整度 | 70% | 95% |

---

## 🚀 立即可用命令

```bash
# 开发模式（热重载）
npm run dev

# 类型检查
npm run typecheck

# 代码审查（当代码完成后）
npm run lint
```

---

**下一步**: 从 Phase 1.1 (HomePage 统计卡片) 开始实现。

