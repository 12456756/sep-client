# 方案 B 实施开发文档

> **设计理念**：视觉叙事风格 - 情感体验型。通过暖色调、大卡片、丰富动画和情感化设计，让用户感受到企业员工平台的温度和专业感。

---

## 📋 目录

1. [项目概述](#项目概述)
2. [技术栈分析](#技术栈分析)
3. [依赖安装](#依赖安装)
4. [设计系统升级](#设计系统升级)
5. [组件实施计划](#组件实施计划)
6. [页面实施计划](#页面实施计划)
7. [实施优先级](#实施优先级)
8. [测试验证](#测试验证)

---

## 项目概述

### 当前状态分析

基于代码调研，项目现状：

**已有基础**：
- ✅ Electron 33 桌面应用（main + renderer IPC 通信）
- ✅ React 18 + TypeScript 5.6
- ✅ Tailwind CSS 4（CSS 变量配置，无 config 文件）
- ✅ Radix UI 原语（Dialog, ScrollArea, Separator, Toast, Tooltip）
- ✅ Lucide Icons（图标库已安装）
- ✅ TanStack Virtual（虚拟滚动已安装）
- ✅ Zustand（状态管理）
- ✅ @xyflow/react（流程图库已安装）
- ✅ 暖陶土色系（#c4612f）+ 温暖奶油背景（#f7f4ef）

**现有页面结构**（14 个页面）：
1. `LoginPage.tsx` (430 行) - 登录页，已有渐变背景
2. `HomePage.tsx` (16KB) - 企业工作台首页
3. `EmployeesPage.tsx` (6KB) - 员工列表页
4. `EmployeeDetailPage.tsx` - 员工详情页
5. `WorkDetailPage.tsx` - 工作详情页
6. `WorkRecordsPage.tsx` (14KB) - 工作记录页
7. `ArrangeWorkPage.tsx` (10KB) - 安排工作页
8. `SkillsPage.tsx` - 技能库页
9. `OrganizationPage.tsx` - 组织架构页
10. `ConversationView.tsx` - 对话视图
11. 其他辅助页面

**现有组件**（21+ 个组件）：
- 卡片类：`EmployeeCard.tsx`, `EmployeeDeskCard.tsx`, `StatCard.tsx`
- 对话类：`WorkspaceComposer.tsx`, `MessageBubble` 相关
- 导航类：`AppSideNav.tsx`, `AppTopBar.tsx`, `AppNavBar.tsx`
- 表单类：`ArrangeBar.tsx`, `GoalComposer.tsx`
- 工具类：`ToolApprovalDialog.tsx` (150+ 行)
- 抽屉类：`EmployeeWorksDrawer.tsx`, `WorkPlanDrawer.tsx`, `WorkTalkDrawer.tsx`
- 其他：`EmployeeFace.tsx`, `VirtualList.tsx`, `atoms.tsx`

### 方案 B 升级目标

**设计定位**：情感体验型、视觉叙事风格

**核心特征**：
- 🎨 **暖色调 + 渐变**：陶土橙 #c4612f → 柔和渐变
- 🃏 **大卡片展示**：380px 高卡片，信息丰富
- ✨ **丰富动画**：framer-motion 驱动的流畅过渡
- 📸 **真实摄影**：大尺寸照片、场景化插图
- 🎭 **情感化交互**：悬停放大、点击反馈、状态动画
- 🖋️ **衬线 + 无衬线**：标题用 Fraunces/DM Serif，正文用 Inter

**对比方案 A**：
| 维度 | 方案 A（极简商务风） | 方案 B（视觉叙事风） |
|------|---------------------|---------------------|
| 卡片高度 | 140px | 380px |
| 圆角 | 6px | 12px |
| 字号 | 14px | 15px |
| 动画 | 最小化（< 200ms） | 丰富（300-600ms） |
| 字体 | 纯 Inter | Fraunces + Inter |
| 色彩 | 中性灰 + 蓝色强调 | 暖陶土 + 渐变 |
| 风格 | Linear / GitHub | Notion / Dribbble |

---

## 技术栈分析

### 当前依赖（package.json）

```json
{
  "dependencies": {
    "@radix-ui/react-dialog": "^1.1.4",
    "@radix-ui/react-scroll-area": "^1.2.2",
    "@radix-ui/react-separator": "^1.1.1",
    "@radix-ui/react-toast": "^1.2.4",
    "@radix-ui/react-tooltip": "^1.1.7",
    "@tanstack/react-virtual": "^3.11.1",
    "@xyflow/react": "^12.11.5",
    "lucide-react": "^0.462.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^7.18.2",
    "zustand": "^5.0.1"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.17",
    "tailwindcss": "^4.1.0",
    "typescript": "^5.6.3",
    "electron": "^33.4.11",
    "electron-vite": "^2.3.0",
    "vite": "^5.4.11"
  }
}
```

### 缺失依赖（需安装）

方案 B 需要以下新依赖：

```bash
# 动画库
npm install framer-motion

# 轮播库（员工卡片墙）
npm install embla-carousel-react

# 图表库（统计可视化）
npm install recharts

# 头像库（增强）
npm install @dicebear/core @dicebear/collection
```

**依赖说明**：

| 包 | 用途 | 大小 | 替代方案 |
|---|------|------|---------|
| `framer-motion` | 页面过渡、卡片动画、抽屉滑入 | ~600KB | CSS 动画（功能受限） |
| `embla-carousel-react` | 员工卡片墙环形轮播 | ~50KB | 手写滚动逻辑 |
| `recharts` | 统计图表（条形图、折线图） | ~500KB | 纯 CSS 进度条（功能受限） |
| `@dicebear/collection` | 增强头像样式 | ~200KB | 保持现有 toon-head |

**是否必须安装**：
- `framer-motion` — **强烈推荐**（方案 B 的核心动画体验）
- `embla-carousel-react` — **推荐**（员工墙的环形滚动）
- `recharts` — 可选（统计图表，可用 CSS 替代）
- `@dicebear/collection` — 可选（头像增强，现有已够用）

---

## 依赖安装

### 方案 1：完整安装（推荐）

```bash
# 安装所有方案 B 依赖
npm install framer-motion embla-carousel-react recharts

# 可选：增强头像
npm install @dicebear/core @dicebear/collection
```

### 方案 2：渐进式安装

```bash
# P0 阶段：只安装核心动画库
npm install framer-motion

# P1 阶段：添加轮播
npm install embla-carousel-react

# P2 阶段：添加图表
npm install recharts
```

### 安装后验证

```bash
# 类型检查
npm run typecheck

# 构建测试
npm run build

# 启动开发服务器
npm run dev
```

---

## 设计系统升级

### CSS 变量更新

**位置**：`src/styles/enterprise.css`

当前变量（2121 行文件）需要更新以下部分：

```css
/* ============================================================================
   方案 B 色彩系统升级
   ============================================================================ */

:root {
  /* 品牌色 - 保持暖陶土主色 */
  --ent-brand: #c4612f;              /* 主色：暖陶土橙 */
  --ent-brand-hover: #a94e22;        /* 悬停：深陶土 */
  --ent-brand-ink: #9a4a1e;          /* 小文字：更深陶土 */
  --ent-brand-soft: #f5e6da;         /* 柔和背景 */
  --ent-brand-tint: #f7ebe1;         /* 淡色提示 */
  
  /* 新增：渐变色 */
  --ent-gradient-warm: linear-gradient(135deg, #c4612f 0%, #e89b6d 100%);
  --ent-gradient-sunset: linear-gradient(135deg, #c4612f 0%, #d97845 50%, #e89b6d 100%);
  --ent-gradient-soft: linear-gradient(135deg, #f7ebe1 0%, #ffffff 100%);
  
  /* 背景层次 */
  --ent-canvas: #f7f4ef;             /* 页面底色：温暖奶油 */
  --ent-panel: #ffffff;              /* 卡片底色：纯白 */
  --ent-hover: #fafaf9;              /* 悬停背景：极浅灰 */
  
  /* 文字层次 */
  --ent-ink: #262320;                /* 主文字：深棕 */
  --ent-ink-secondary: #5c5350;      /* 次要文字：中棕 */
  --ent-ink-tertiary: #9a9490;       /* 辅助文字：浅棕 */
  
  /* 边框 */
  --ent-border: #e7e1d7;             /* 主边框：暖灰 */
  --ent-border-subtle: #f2ede5;      /* 微妙边框：极浅 */
  
  /* 语义色 */
  --ent-ready: #1a7f52;              /* 绿色：可用 */
  --ent-busy: #c4612f;               /* 陶土：工作中 */
  --ent-attention: #8a6410;          /* 琥珀：需关注 */
  --ent-danger: #bf3149;             /* 红色：危险 */
  
  /* 阴影系统（方案 B 增强） */
  --ent-shadow-sm: 0 2px 8px 0 rgb(90 70 50 / 0.06);
  --ent-shadow-md: 0 4px 16px 0 rgb(90 70 50 / 0.08);
  --ent-shadow-lg: 0 8px 32px 0 rgb(90 70 50 / 0.12);
  --ent-shadow-xl: 0 16px 48px 0 rgb(90 70 50 / 0.16);
  --ent-shadow-hover: 0 8px 24px 0 rgb(196 97 47 / 0.15);  /* 陶土色悬停 */
  
  /* 圆角系统（方案 B 放大） */
  --ent-radius-sm: 8px;              /* 小：按钮、标签 */
  --ent-radius-md: 12px;             /* 中：卡片 */
  --ent-radius-lg: 16px;             /* 大：对话框、大卡片 */
  --ent-radius-xl: 20px;             /* 超大：封面图 */
  --ent-radius-full: 999px;          /* 全圆：头像、药丸 */
  
  /* 间距系统（方案 B 放大） */
  --ent-space-xs: 8px;
  --ent-space-sm: 12px;
  --ent-space-md: 16px;
  --ent-space-lg: 24px;
  --ent-space-xl: 32px;
  --ent-space-2xl: 48px;
  --ent-space-3xl: 64px;
  
  /* 字体系统 */
  --ent-font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --ent-font-serif: 'Fraunces', 'DM Serif Display', 'Playfair Display', Georgia, serif;
  
  /* 字号（方案 B 稍大） */
  --ent-text-xs: 12px;
  --ent-text-sm: 13px;
  --ent-text-base: 15px;            /* 主字号从 13 → 15 */
  --ent-text-lg: 17px;
  --ent-text-xl: 20px;
  --ent-text-2xl: 25px;
  --ent-text-3xl: 32px;
  --ent-text-4xl: 40px;
  
  /* 动画时长（方案 B 更长） */
  --ent-duration-fast: 200ms;
  --ent-duration-normal: 300ms;
  --ent-duration-slow: 500ms;
  --ent-duration-slower: 800ms;
  
  /* 动画缓动 */
  --ent-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ent-ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --ent-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* 深色模式（方案 B 同样更新） */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ent-canvas: #1a1816;
    --ent-panel: #262320;
    --ent-hover: #2d2a27;
    --ent-ink: #f7f4ef;
    --ent-ink-secondary: #c4bfb7;
    --ent-ink-tertiary: #8a857e;
    --ent-border: #3d3a37;
    --ent-border-subtle: #2d2a27;
    
    /* 渐变调整为深色模式 */
    --ent-gradient-warm: linear-gradient(135deg, #c4612f 0%, #a94e22 100%);
    --ent-gradient-sunset: linear-gradient(135deg, #c4612f 0%, #b35428 50%, #9a4a1e 100%);
    --ent-gradient-soft: linear-gradient(135deg, #262320 0%, #3d3a37 100%);
    
    /* 阴影调整为深色模式 */
    --ent-shadow-sm: 0 2px 8px 0 rgb(0 0 0 / 0.3);
    --ent-shadow-md: 0 4px 16px 0 rgb(0 0 0 / 0.4);
    --ent-shadow-lg: 0 8px 32px 0 rgb(0 0 0 / 0.5);
    --ent-shadow-xl: 0 16px 48px 0 rgb(0 0 0 / 0.6);
    --ent-shadow-hover: 0 8px 24px 0 rgb(196 97 47 / 0.4);
  }
}

/* 减少动效模式（方案 B 遵守可访问性） */
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

### 字体加载（新增）

**位置**：`src/index.html`

在 `<head>` 中添加 Google Fonts 引入：

```html
<!-- 衬线字体：Fraunces（可变字体） -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..700;1,9..144,300..700&display=swap" rel="stylesheet">

<!-- 备选方案：DM Serif Display -->
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&display=swap" rel="stylesheet">

<!-- Inter 已有，保持不变 -->
```

**字体使用规则**：
- **标题**：`font-family: var(--ent-font-serif)` — Fraunces/DM Serif
- **正文**：`font-family: var(--ent-font-sans)` — Inter
- **代码**：`font-family: 'Monaco', 'Courier New', monospace`

---

## 组件实施计划

### 1. EmployeeCard（员工卡片）— 大卡片展示风格

**当前状态**：`src/components/enterprise/EmployeeCard.tsx`
- 紧凑卡片，约 160px 高
- 头像 + 姓名 + 状态 + 擅长标签
- 简单的 hover 阴影效果

**方案 B 升级**：380px 高的展示型大卡片

#### 升级后代码示例

```typescript
// src/components/enterprise/EmployeeCard.tsx
import { motion } from 'framer-motion';
import { MessageSquare, Zap, Clock, CheckCircle2 } from 'lucide-react';
import { EmployeeFace } from './EmployeeFace';

interface EmployeeCardProps {
  id: string;
  name: string;
  roleName: string;
  department?: string;
  availability: 'ready' | 'working' | 'unavailable';
  goodAt: string[];
  workStats?: {
    todayCompleted: number;
    todayTotal: number;
    avgResponseTime: string;
  };
  onStartConversation?: () => void;
}

export function EmployeeCard({
  id,
  name,
  roleName,
  department,
  availability,
  goodAt,
  workStats,
  onStartConversation,
}: EmployeeCardProps) {
  const availabilityConfig = {
    ready: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700', label: '空闲' },
    working: { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700', label: '工作中' },
    unavailable: { bg: 'bg-gray-50', border: 'border-gray-200', text: 'text-gray-600', label: '不可用' },
  };

  const config = availabilityConfig[availability];

  return (
    <motion.article
      className="ent-card-showcase group"
      whileHover={{ y: -8, scale: 1.02 }}
      transition={{ duration: 0.3, ease: [0.34, 1.56, 0.64, 1] }}
    >
      {/* 顶部渐变背景 */}
      <div className="absolute inset-0 bg-gradient-to-br from-orange-50 via-white to-amber-50 opacity-60 rounded-xl" />
      
      {/* 内容区 */}
      <div className="relative z-10 p-6 flex flex-col h-full">
        {/* 头像 + 基本信息 */}
        <div className="flex items-start gap-4 mb-4">
          <motion.div
            whileHover={{ scale: 1.1, rotate: 5 }}
            transition={{ duration: 0.2 }}
          >
            <EmployeeFace seed={id} size="xl" className="w-20 h-20" />
          </motion.div>
          
          <div className="flex-1 min-w-0">
            <h3 className="font-serif text-2xl font-medium text-gray-900 mb-1 truncate">
              {name}
            </h3>
            <p className="text-sm text-gray-600 mb-2">{roleName}</p>
            {department && (
              <p className="text-xs text-gray-500">{department}</p>
            )}
          </div>
          
          {/* 状态指示器 */}
          <div className={`${config.bg} ${config.border} border px-3 py-1.5 rounded-full`}>
            <span className={`${config.text} text-xs font-medium`}>{config.label}</span>
          </div>
        </div>

        {/* 擅长标签（渐变背景） */}
        <div className="mb-4">
          <p className="text-xs text-gray-500 mb-2">擅长领域</p>
          <div className="flex flex-wrap gap-2">
            {goodAt.slice(0, 4).map((skill, i) => (
              <motion.span
                key={skill}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: i * 0.1 }}
                className="px-3 py-1.5 bg-gradient-to-r from-orange-100 to-amber-100 text-orange-800 text-xs font-medium rounded-full"
              >
                {skill}
              </motion.span>
            ))}
          </div>
        </div>

        {/* 工作统计 */}
        {workStats && (
          <div className="mt-auto pt-4 border-t border-gray-100">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <div className="flex items-center justify-center gap-1 text-emerald-600 mb-1">
                  <CheckCircle2 size={14} />
                  <span className="text-xl font-semibold">{workStats.todayCompleted}</span>
                </div>
                <p className="text-xs text-gray-500">今日完成</p>
              </div>
              <div>
                <div className="flex items-center justify-center gap-1 text-gray-600 mb-1">
                  <Zap size={14} />
                  <span className="text-xl font-semibold">{workStats.todayTotal}</span>
                </div>
                <p className="text-xs text-gray-500">总任务</p>
              </div>
              <div>
                <div className="flex items-center justify-center gap-1 text-blue-600 mb-1">
                  <Clock size={14} />
                  <span className="text-sm font-semibold">{workStats.avgResponseTime}</span>
                </div>
                <p className="text-xs text-gray-500">平均响应</p>
              </div>
            </div>
          </div>
        )}

        {/* 底部操作按钮 */}
        <motion.button
          onClick={onStartConversation}
          className="mt-4 w-full bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white font-medium py-3 px-4 rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-orange-500/30"
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <MessageSquare size={18} />
          开始对话
        </motion.button>
      </div>
    </motion.article>
  );
}
```

#### 配套 CSS（添加到 `enterprise.css`）

```css
/* 大卡片展示风格 */
.ent-card-showcase {
  position: relative;
  height: 380px;
  background: white;
  border-radius: var(--ent-radius-lg);
  border: 1px solid var(--ent-border-subtle);
  overflow: hidden;
  transition: all var(--ent-duration-normal) var(--ent-ease-out);
  cursor: pointer;
}

.ent-card-showcase:hover {
  box-shadow: var(--ent-shadow-hover);
  border-color: var(--ent-brand);
}

.ent-card-showcase::before {
  content: '';
  position: absolute;
  top: -50%;
  right: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(circle, rgba(196, 97, 47, 0.05) 0%, transparent 70%);
  opacity: 0;
  transition: opacity var(--ent-duration-slow);
}

.ent-card-showcase:hover::before {
  opacity: 1;
}
```

#### 迁移清单

- [ ] 安装 `framer-motion`
- [ ] 复制新组件代码
- [ ] 添加 `.ent-card-showcase` 样式到 CSS
- [ ] 更新 `HomePage.tsx` 中的员工网格为 3 列（从 4 列）
- [ ] 测试响应式布局（1200x800 最小）
- [ ] 验证动画在 `prefers-reduced-motion` 下禁用

---

### 2. StatCard（统计卡片）— 渐变背景 + 数字动画

**当前状态**：`src/components/enterprise/StatCard.tsx`
- 简单白色卡片
- 静态数字显示
- 无渐变、无动画

**方案 B 升级**：渐变背景 + 数字计数动画

#### 升级后代码示例

```typescript
// src/components/enterprise/StatCard.tsx
import { motion, useSpring, useTransform } from 'framer-motion';
import { useEffect } from 'react';
import { LucideIcon } from 'lucide-react';

interface StatCardProps {
  value: number;
  label: string;
  icon?: LucideIcon;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  gradient?: 'warm' | 'blue' | 'green' | 'purple';
}

export function StatCard({ value, label, icon: Icon, trend, gradient = 'warm' }: StatCardProps) {
  // 数字动画
  const spring = useSpring(0, { stiffness: 100, damping: 30 });
  const display = useTransform(spring, (current) => Math.round(current));

  useEffect(() => {
    spring.set(value);
  }, [spring, value]);

  const gradientClasses = {
    warm: 'from-orange-500 to-amber-500',
    blue: 'from-blue-500 to-cyan-500',
    green: 'from-emerald-500 to-teal-500',
    purple: 'from-purple-500 to-pink-500',
  };

  return (
    <motion.div
      className="relative overflow-hidden rounded-2xl p-6 shadow-lg"
      whileHover={{ scale: 1.05, y: -4 }}
      transition={{ duration: 0.3 }}
    >
      {/* 渐变背景 */}
      <div className={`absolute inset-0 bg-gradient-to-br ${gradientClasses[gradient]} opacity-90`} />
      
      {/* 装饰性圆圈 */}
      <div className="absolute -right-8 -bottom-8 w-32 h-32 bg-white/10 rounded-full blur-2xl" />
      <div className="absolute -left-4 -top-4 w-24 h-24 bg-white/10 rounded-full blur-xl" />
      
      {/* 内容 */}
      <div className="relative z-10">
        {/* 图标 */}
        {Icon && (
          <div className="inline-flex items-center justify-center w-12 h-12 bg-white/20 rounded-xl mb-4">
            <Icon size={24} className="text-white" />
          </div>
        )}
        
        {/* 数字 */}
        <div className="flex items-baseline gap-2 mb-2">
          <motion.div className="text-5xl font-bold text-white">
            {display}
          </motion.div>
          
          {trend && (
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              className={`text-sm font-medium ${trend.isPositive ? 'text-white/90' : 'text-white/70'}`}
            >
              {trend.isPositive ? '+' : ''}{trend.value}%
            </motion.div>
          )}
        </div>
        
        {/* 标签 */}
        <p className="text-white/80 text-sm font-medium">{label}</p>
      </div>
    </motion.div>
  );
}
```

#### 迁移清单

- [ ] 更新 StatCard 组件代码
- [ ] 在 HomePage 添加渐变配置
- [ ] 添加图标参数传递
- [ ] 测试数字动画性能
- [ ] 验证深色模式下的对比度

---

### 3. ToolApprovalDialog（工具审批）— 戏剧化设计

**当前状态**：`src/components/ToolApprovalDialog.tsx` (150+ 行)
- 白色对话框
- 简单的倒计时
- 橙色警告提示

**方案 B 升级**：戏剧化的全屏遮罩 + 脉动倒计时

#### 升级后代码示例

```typescript
// src/components/ToolApprovalDialog.tsx
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, X, Wrench } from 'lucide-react';
import { Button } from './ui/Button';

interface ToolApprovalRequest {
  toolName: string;
  input: unknown;
}

interface ToolApprovalDialogProps {
  request: ToolApprovalRequest | null;
  onApprove: () => void;
  onDeny: () => void;
}

const TIMEOUT_SECONDS = 60;

const TOOL_DESCRIPTIONS: Record<string, { title: string; description: string; risk: string }> = {
  bash: {
    title: 'Shell 命令执行',
    description: 'AI 请求在您的系统上执行 Shell 命令',
    risk: '可能修改文件、安装软件或访问系统资源',
  },
  write: {
    title: '创建/覆写文件',
    description: 'AI 请求创建新文件或覆盖现有文件',
    risk: '可能覆盖重要文件导致数据丢失',
  },
  edit: {
    title: '编辑文件',
    description: 'AI 请求修改现有文件内容',
    risk: '可能修改代码或配置文件',
  },
};

export function ToolApprovalDialog({ request, onApprove, onDeny }: ToolApprovalDialogProps) {
  const [countdown, setCountdown] = useState(TIMEOUT_SECONDS);
  const denyButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    setCountdown(TIMEOUT_SECONDS);

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          onDeny();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [request, onDeny]);

  useEffect(() => {
    if (request) denyButtonRef.current?.focus();
  }, [request]);

  if (!request) return null;

  const toolInfo = TOOL_DESCRIPTIONS[request.toolName] || {
    title: `未知工具: ${request.toolName}`,
    description: 'AI 请求执行一个未知的工具',
    risk: '未知风险，建议拒绝',
  };

  const formatInput = (input: unknown): string => {
    if (typeof input === 'string') return input;
    if (typeof input === 'object' && input !== null) {
      return JSON.stringify(input, null, 2);
    }
    return String(input);
  };

  const inputDisplay = formatInput(request.input);
  const shouldTruncate = inputDisplay.length > 500;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        {/* 戏剧化背景遮罩 */}
        <motion.div
          className="absolute inset-0 bg-gradient-to-br from-red-900/40 via-orange-900/40 to-red-900/40 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        />
        
        {/* 脉动光晕效果 */}
        <motion.div
          className="absolute inset-0"
          animate={{
            background: [
              'radial-gradient(circle at 50% 50%, rgba(239, 68, 68, 0.2) 0%, transparent 50%)',
              'radial-gradient(circle at 50% 50%, rgba(239, 68, 68, 0.1) 0%, transparent 60%)',
              'radial-gradient(circle at 50% 50%, rgba(239, 68, 68, 0.2) 0%, transparent 50%)',
            ],
          }}
          transition={{ duration: 2, repeat: Infinity }}
        />

        {/* 对话框主体 */}
        <motion.div
          className="relative bg-white dark:bg-gray-900 rounded-3xl shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden"
          initial={{ scale: 0.9, y: 50 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.9, y: 50 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        >
          {/* 顶部警告条 */}
          <div className="bg-gradient-to-r from-red-600 to-orange-600 p-6">
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-4">
                <motion.div
                  animate={{ rotate: [0, -10, 10, -10, 0] }}
                  transition={{ duration: 0.5, repeat: Infinity, repeatDelay: 2 }}
                >
                  <AlertTriangle size={40} className="text-white" />
                </motion.div>
                <div>
                  <h2 className="text-2xl font-serif font-bold text-white mb-1">
                    工具执行授权
                  </h2>
                  <p className="text-white/90">{toolInfo.description}</p>
                </div>
              </div>
              
              {/* 大号倒计时 */}
              <div className="text-center">
                <motion.div
                  className="text-6xl font-bold text-white mb-1"
                  animate={{
                    scale: countdown <= 10 ? [1, 1.2, 1] : 1,
                    color: countdown <= 10 ? ['#ffffff', '#fee2e2', '#ffffff'] : '#ffffff',
                  }}
                  transition={{ duration: 1, repeat: countdown <= 10 ? Infinity : 0 }}
                >
                  {countdown}
                </motion.div>
                <div className="text-xs text-white/80 uppercase tracking-wider">秒后自动拒绝</div>
              </div>
            </div>
          </div>

          {/* 内容区域 */}
          <div className="p-8 overflow-y-auto max-h-[calc(90vh-300px)]">
            {/* 风险警告 */}
            <motion.div
              className="bg-red-50 dark:bg-red-900/20 border-2 border-red-200 dark:border-red-800 rounded-2xl p-6 mb-6"
              initial={{ x: -20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ delay: 0.2 }}
            >
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-12 h-12 bg-red-100 dark:bg-red-900/40 rounded-xl flex items-center justify-center">
                  <Wrench size={24} className="text-red-600 dark:text-red-400" />
                </div>
                <div>
                  <h3 className="font-semibold text-red-900 dark:text-red-100 mb-2">
                    {toolInfo.title}
                  </h3>
                  <p className="text-red-700 dark:text-red-300 text-sm">
                    {toolInfo.risk}
                  </p>
                </div>
              </div>
            </motion.div>

            {/* 工具名称 */}
            <motion.div
              className="mb-6"
              initial={{ x: -20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ delay: 0.3 }}
            >
              <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
                工具名称
              </label>
              <div className="bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-900 px-5 py-4 rounded-xl border border-gray-200 dark:border-gray-700">
                <code className="text-orange-600 dark:text-orange-400 font-mono text-lg font-semibold">
                  {request.toolName}
                </code>
              </div>
            </motion.div>

            {/* 参数内容 */}
            <motion.div
              initial={{ x: -20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ delay: 0.4 }}
            >
              <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
                参数内容
              </label>
              <pre className="bg-gray-900 text-gray-100 p-5 rounded-xl overflow-x-auto text-sm font-mono max-h-64 border border-gray-700">
                {shouldTruncate ? inputDisplay.slice(0, 500) + '\n\n... (内容过长，已截断)' : inputDisplay}
              </pre>
            </motion.div>
          </div>

          {/* 底部操作区 */}
          <div className="bg-gray-50 dark:bg-gray-800/50 px-8 py-6 flex items-center justify-between gap-4 border-t border-gray-200 dark:border-gray-700">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              审慎评估工具执行的必要性和安全性
            </p>
            <div className="flex gap-3">
              <Button
                ref={denyButtonRef}
                onClick={onDeny}
                variant="ghost"
                size="lg"
                className="min-w-[120px] font-semibold"
              >
                拒绝
              </Button>
              <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                <Button
                  onClick={onApprove}
                  variant="primary"
                  size="lg"
                  className="min-w-[120px] bg-gradient-to-r from-orange-600 to-red-600 hover:from-orange-700 hover:to-red-700 font-semibold shadow-lg"
                >
                  批准执行
                </Button>
              </motion.div>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
```

#### 迁移清单

- [ ] 更新 ToolApprovalDialog 代码
- [ ] 测试倒计时动画性能
- [ ] 验证键盘焦点管理（拒绝按钮默认焦点）
- [ ] 测试 60 秒超时自动拒绝
- [ ] 验证 `prefers-reduced-motion` 下动画禁用

---

### 4. ConversationView（对话界面）— 沉浸式体验

**当前状态**：基本消息列表，简单气泡

**方案 B 目标**：
- 消息气泡带渐变背景和阴影
- 流式输出打字机效果
- 工具调用卡片化展示
- 消息进入动画
- 自动滚动到底部

#### 实现代码

```typescript
// src/pages/enterprise/ConversationView.tsx
import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Wrench, User, Sparkles, AlertCircle } from 'lucide-react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  toolCall?: {
    name: string;
    status: 'running' | 'completed' | 'failed';
  };
}

export function ConversationView({ messages }: { messages: Message[] }) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex flex-col h-full bg-gradient-to-br from-cream to-white dark:from-gray-900 dark:to-gray-800">
      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto px-6 py-8">
        <AnimatePresence mode="popLayout">
          {messages.map((msg, idx) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.4, delay: idx * 0.05 }}
              className={`mb-6 flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div className={`max-w-[75%] ${msg.role === 'user' ? 'items-end' : 'items-start'} flex flex-col gap-2`}>
                {/* 头像 + 名称 */}
                <div className="flex items-center gap-2 px-2">
                  {msg.role === 'assistant' ? (
                    <Sparkles className="w-5 h-5 text-terracotta" />
                  ) : (
                    <User className="w-5 h-5 text-gray-600" />
                  )}
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {msg.role === 'assistant' ? 'AI 员工' : '我'}
                  </span>
                  <span className="text-xs text-gray-500">
                    {msg.timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>

                {/* 消息气泡 */}
                <motion.div
                  whileHover={{ scale: 1.01 }}
                  className={`px-5 py-4 rounded-2xl shadow-md ${
                    msg.role === 'user'
                      ? 'bg-gradient-to-br from-terracotta to-orange-600 text-white'
                      : 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700'
                  }`}
                >
                  <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                </motion.div>

                {/* 工具调用卡片 */}
                {msg.toolCall && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 border border-blue-200 dark:border-blue-800 rounded-xl px-4 py-3 flex items-center gap-3"
                  >
                    <Wrench className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    <span className="text-sm font-medium text-blue-900 dark:text-blue-100">
                      {msg.toolCall.name}
                    </span>
                    {msg.toolCall.status === 'running' && (
                      <div className="ml-auto">
                        <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}
                    {msg.toolCall.status === 'failed' && (
                      <AlertCircle className="ml-auto w-4 h-4 text-red-600" />
                    )}
                  </motion.div>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}
```

#### 迁移清单

- [ ] 更新 ConversationView 组件
- [ ] 添加消息进入动画
- [ ] 实现工具调用卡片
- [ ] 测试自动滚动行为
- [ ] 验证长消息和代码块渲染

---

### 5. AppSideNav（侧边导航）— 优雅过渡

**当前状态**：静态导航列表

**方案 B 目标**：
- 导航项悬停放大效果
- 选中项带渐变背景
- 图标和文字独立动画
- Logo 区域呼吸动画

#### 实现代码

```typescript
// src/components/AppSideNav.tsx
import React from 'react';
import { motion } from 'framer-motion';
import { Home, Users, Briefcase, Settings, MessageSquare, Calendar } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';

const navItems = [
  { path: '/home', label: '工作台', icon: Home },
  { path: '/employees', label: '员工', icon: Users },
  { path: '/tasks', label: '任务', icon: Briefcase },
  { path: '/calendar', label: '日程', icon: Calendar },
  { path: '/settings', label: '设置', icon: Settings },
];

export function AppSideNav() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <motion.nav
      initial={{ x: -20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      className="w-64 h-full bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col"
    >
      {/* Logo 区域 */}
      <div className="px-6 py-8 border-b border-gray-200 dark:border-gray-800">
        <motion.div
          animate={{ scale: [1, 1.02, 1] }}
          transition={{ duration: 2, repeat: Infinity, repeatType: 'reverse' }}
          className="flex items-center gap-3"
        >
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-terracotta to-orange-600 flex items-center justify-center shadow-lg">
            <MessageSquare className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-serif font-semibold text-gray-900 dark:text-gray-100">
              硅基员工
            </h1>
            <p className="text-xs text-gray-500">Silicon Employee</p>
          </div>
        </motion.div>
      </div>

      {/* 导航列表 */}
      <div className="flex-1 px-3 py-6 space-y-2">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path;
          const Icon = item.icon;

          return (
            <motion.button
              key={item.path}
              onClick={() => navigate(item.path)}
              whileHover={{ scale: 1.03, x: 4 }}
              whileTap={{ scale: 0.98 }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${
                isActive
                  ? 'bg-gradient-to-r from-terracotta/10 to-orange-600/10 border border-terracotta/30'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              <motion.div
                animate={isActive ? { rotate: [0, -10, 10, 0] } : {}}
                transition={{ duration: 0.5 }}
              >
                <Icon
                  className={`w-5 h-5 ${
                    isActive ? 'text-terracotta' : 'text-gray-600 dark:text-gray-400'
                  }`}
                />
              </motion.div>
              <span
                className={`text-[15px] font-medium ${
                  isActive ? 'text-terracotta' : 'text-gray-700 dark:text-gray-300'
                }`}
              >
                {item.label}
              </span>
              {isActive && (
                <motion.div
                  layoutId="activeIndicator"
                  className="ml-auto w-1.5 h-1.5 rounded-full bg-terracotta"
                  transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                />
              )}
            </motion.button>
          );
        })}
      </div>

      {/* 快捷操作 */}
      <div className="px-3 pb-6 border-t border-gray-200 dark:border-gray-800 pt-4">
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          className="w-full px-4 py-3 bg-gradient-to-r from-terracotta to-orange-600 text-white rounded-xl font-medium shadow-lg hover:shadow-xl transition-shadow"
        >
          + 新建对话
        </motion.button>
      </div>
    </motion.nav>
  );
}
```

#### 迁移清单

- [ ] 更新 AppSideNav 组件
- [ ] 添加导航项动画
- [ ] 实现活动指示器
- [ ] 测试导航切换流畅度
- [ ] 验证键盘导航（Tab / Enter）

---

### 6. LoginPage（登录页）— 温暖迎接

**当前状态**：indigo 按钮，ambient 渐变

**方案 B 目标**：
- 暖色系渐变背景
- 陶土色按钮
- 入场动画
- 错误状态温和提示

#### 实现代码

```typescript
// src/pages/LoginPage.tsx（部分更新）
import { motion } from 'framer-motion';

export function LoginPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-cream via-orange-50 to-terracotta/20 flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="w-full max-w-md"
      >
        {/* Logo */}
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.5 }}
          className="text-center mb-8"
        >
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-terracotta to-orange-600 shadow-2xl mb-4">
            <MessageSquare className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-serif font-semibold text-gray-900 mb-2">
            硅基员工平台
          </h1>
          <p className="text-gray-600">Silicon Employee Platform</p>
        </motion.div>

        {/* 登录表单 */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.5 }}
          className="bg-white/80 backdrop-blur-xl rounded-3xl shadow-2xl p-8 border border-white/50"
        >
          {/* 表单字段... */}

          {/* 登录按钮 */}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            type="submit"
            className="w-full py-3.5 bg-gradient-to-r from-terracotta to-orange-600 text-white rounded-xl font-semibold shadow-lg hover:shadow-xl transition-all"
          >
            登录
          </motion.button>
        </motion.div>
      </motion.div>
    </div>
  );
}
```

#### 迁移清单

- [ ] 更新 LoginPage 渐变背景
- [ ] 更新按钮颜色为陶土色
- [ ] 添加入场动画
- [ ] 测试表单验证提示
- [ ] 验证自动聚焦和键盘导作

---

## 六、页面实现计划

### 1. HomePage（首页）— 3 列大卡片 + 渐变背景

**当前结构**：
```typescript
<div className="home-page">
  <header>标题 + 统计</header>
  <section>员工网格 4 列</section>
</div>
```

**方案 B 结构**：
```typescript
<div className="min-h-screen bg-gradient-to-br from-cream via-white to-orange-50">
  {/* 顶部统计卡片 */}
  <motion.div className="grid grid-cols-4 gap-6 mb-8">
    <StatCard variant="warm" /> {/* 4 种渐变变体 */}
    <StatCard variant="sunset" />
    <StatCard variant="cool" />
    <StatCard variant="neutral" />
  </motion.div>

  {/* 员工网格：3 列 */}
  <motion.div className="grid grid-cols-3 gap-8">
    {employees.map((emp, idx) => (
      <motion.div
        key={emp.id}
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: idx * 0.1 }}
      >
        <EmployeeCard {...emp} />
      </motion.div>
    ))}
  </motion.div>
</div>
```

**实施要点**：
- 页面渐变背景：`from-cream via-white to-orange-50`
- 员工卡片从 4 列改为 3 列（`grid-cols-4` → `grid-cols-3`）
- 卡片间距从 `gap-4` 增加到 `gap-8`
- 添加 staggered 入场动画（每张卡片延迟 0.1s）
- StatCard 使用 4 种渐变变体

**迁移清单**：
- [ ] 更新 HomePage 布局为 3 列
- [ ] 添加页面渐变背景
- [ ] 集成新的 EmployeeCard 组件
- [ ] 添加 staggered 动画
- [ ] 测试响应式布局（1200x800 和 960x640）

---

### 2. EmployeesPage（员工列表页）— 网格 / 列表切换

**当前状态**：4 列卡片网格，简单筛选

**方案 B 增强**：
- 默认 3 列网格（大卡片）
- 列表视图：紧凑行，带头像和关键信息
- 动态视图切换动画
- 筛选器带渐变高亮

**实施要点**：
```typescript
const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

<div className="employees-page bg-gradient-to-br from-cream to-white min-h-screen p-8">
  {/* 工具栏 */}
  <div className="flex items-center justify-between mb-6">
    <SearchInput />
    <SegmentControl value={scope} onChange={setScope} />
    <div className="flex gap-2">
      <Button
        variant={viewMode === 'grid' ? 'primary' : 'ghost'}
        onClick={() => setViewMode('grid')}
      >
        <LayoutGrid />
      </Button>
      <Button
        variant={viewMode === 'list' ? 'primary' : 'ghost'}
        onClick={() => setViewMode('list')}
      >
        <List />
      </Button>
    </div>
  </div>

  {/* 视图容器 */}
  <AnimatePresence mode="wait">
    {viewMode === 'grid' ? (
      <motion.div
        key="grid"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="grid grid-cols-3 gap-8"
      >
        {employees.map(emp => <EmployeeCard key={emp.id} {...emp} />)}
      </motion.div>
    ) : (
      <motion.div
        key="list"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="space-y-3"
      >
        {employees.map(emp => <EmployeeListItem key={emp.id} {...emp} />)}
      </motion.div>
    )}
  </AnimatePresence>
</div>
```

**迁移清单**：
- [ ] 添加视图模式切换逻辑
- [ ] 实现 EmployeeListItem 组件（紧凑行）
- [ ] 添加视图切换动画
- [ ] 更新工具栏样式（渐变按钮）
- [ ] 测试大数据量渲染性能（100+ 员工）

---

### 3. WorkRecordsPage（工作记录页）— 时间轴卡片

**当前状态**：表格视图

**方案 B 改进**：
- 卡片式时间轴布局
- 每张卡片带状态渐变背景
- 悬停展开详情
- 筛选器带动画

**实施要点**：
```typescript
<div className="work-records-page bg-gradient-to-br from-cream to-white min-h-screen p-8">
  {/* 筛选栏 */}
  <div className="mb-6 flex gap-4">
    <Select value={statusFilter} onChange={setStatusFilter}>
      <option value="all">全部状态</option>
      <option value="completed">已完成</option>
      <option value="failed">失败</option>
    </Select>
    <DateRangePicker value={dateRange} onChange={setDateRange} />
  </div>

  {/* 时间轴 */}
  <div className="space-y-4">
    {records.map((record, idx) => (
      <motion.div
        key={record.id}
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: idx * 0.05 }}
        className={`p-6 rounded-2xl shadow-md border-l-4 ${getStatusColor(record.status)}`}
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-serif text-lg font-semibold mb-2">{record.title}</h3>
            <p className="text-sm text-gray-600 mb-3">{record.description}</p>
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span>👤 {record.employeeName}</span>
              <span>⏱️ {formatDuration(record.duration)}</span>
              <span>📅 {formatDate(record.createdAt)}</span>
            </div>
          </div>
          <StatusBadge status={record.status} />
        </div>
      </motion.div>
    ))}
  </div>
</div>
```

**迁移清单**：
- [ ] 将表格布局改为时间轴卡片
- [ ] 添加状态渐变背景
- [ ] 实现悬停展开详情
- [ ] 添加筛选器动画
- [ ] 测试分页和滚动加载

---

### 4. ArrangeWorkPage（安排工作页）— 模式选择卡片

**当前状态**：表单式输入

**方案 B 改进**：
- 3 张大卡片选择工作模式（单次对话 / 工作流 / 多人协作）
- 卡片带插图和渐变背景
- 选中卡片放大高亮
- 模式切换带过渡动画

**实施要点**：
```typescript
const modes = [
  { id: 'conversation', label: '单次对话', icon: '💬', gradient: 'from-blue-500 to-cyan-500' },
  { id: 'workflow', label: '工作流', icon: '🔄', gradient: 'from-purple-500 to-pink-500' },
  { id: 'collaboration', label: '多人协作', icon: '👥', gradient: 'from-orange-500 to-red-500' },
];

<div className="arrange-work-page bg-gradient-to-br from-cream to-white min-h-screen p-8">
  <h1 className="text-3xl font-serif font-semibold mb-8 text-center">选择工作模式</h1>
  
  <div className="grid grid-cols-3 gap-8 mb-8">
    {modes.map((mode) => (
      <motion.button
        key={mode.id}
        whileHover={{ scale: 1.05, y: -8 }}
        whileTap={{ scale: 0.98 }}
        onClick={() => setSelectedMode(mode.id)}
        className={`p-8 rounded-3xl shadow-xl border-4 transition-all ${
          selectedMode === mode.id
            ? 'border-terracotta bg-white'
            : 'border-transparent bg-white/60'
        }`}
      >
        <div className={`w-20 h-20 mx-auto mb-4 rounded-2xl bg-gradient-to-br ${mode.gradient} flex items-center justify-center text-4xl shadow-lg`}>
          {mode.icon}
        </div>
        <h3 className="text-xl font-serif font-semibold mb-2">{mode.label}</h3>
        <p className="text-sm text-gray-600">适用于 XXX 场景</p>
      </motion.button>
    ))}
  </div>

  {/* 模式配置表单 */}
  <AnimatePresence mode="wait">
    {selectedMode && (
      <motion.div
        key={selectedMode}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        className="bg-white rounded-2xl shadow-lg p-8"
      >
        {/* 根据 selectedMode 渲染不同表单 */}
      </motion.div>
    )}
  </AnimatePresence>
</div>
```

**迁移清单**：
- [ ] 实现 3 张模式选择卡片
- [ ] 添加卡片悬停和选中动画
- [ ] 实现模式切换过渡
- [ ] 集成现有表单逻辑
- [ ] 测试键盘导航（方向键选择）

---

## 七、实施优先级

### P0 — 基础设施（1-2 天）

**必须先完成，阻塞后续工作**：

1. **安装依赖**（5 分钟）
   ```bash
   npm install framer-motion embla-carousel-react recharts
   ```

2. **更新 CSS 变量**（30 分钟）
   - 修改 `src/styles/enterprise.css` 中的 `:root` 变量
   - 添加渐变、字体、动画时长变量
   - 测试深色模式适配

3. **字体加载**（10 分钟）
   - 在 `src/index.html` 添加 Google Fonts 引用
   - 验证字体加载和回退

**验证**：
```bash
npm run dev
# 打开 DevTools，检查：
# 1. CSS 变量是否生效（Elements > Computed）
# 2. 字体是否加载（Network > Fonts）
# 3. framer-motion 是否可用（Console 中 import 测试）
```

---

### P1 — 核心组件（3-5 天）

**并行开发，互不依赖**：

#### P1.1 EmployeeCard（2 天）
- 实现 380px 大卡片布局
- 添加渐变背景和阴影
- 实现悬停动画
- 集成 Zustand 数据
- 编写单元测试

#### P1.2 StatCard（1 天）
- 实现 4 种渐变变体
- 添加数字滚动动画
- 测试性能（60 FPS）

#### P1.3 ToolApprovalDialog（1.5 天）
- 实现全屏渐变背景
- 添加倒计时脉动动画
- 集成现有审批逻辑
- 测试键盘快捷键

#### P1.4 AppSideNav（1 天）
- 添加导航项动画
- 实现活动指示器
- 测试路由集成

**验证**：
- 每个组件独立运行无报错
- 动画流畅（Chrome DevTools Performance 面板，FPS > 50）
- 键盘导航和焦点管理正常

---

### P2 — 页面集成（5-7 天）

**顺序开发，依赖 P1 组件**：

#### P2.1 HomePage（2 天）
- 集成新 EmployeeCard
- 实现 3 列布局
- 添加 staggered 动画
- 测试响应式

#### P2.2 EmployeesPage（2 天）
- 实现网格 / 列表视图切换
- 添加筛选器动画
- 测试大数据量渲染

#### P2.3 WorkRecordsPage（1.5 天）
- 改为时间轴卡片布局
- 添加状态渐变
- 测试分页

#### P2.4 ArrangeWorkPage（1.5 天）
- 实现模式选择卡片
- 添加切换动画
- 集成表单逻辑

#### P2.5 LoginPage（1 天）
- 更新渐变背景和按钮
- 添加入场动画
- 测试表单验证

**验证**：
- 所有页面路由正常
- 数据加载和状态管理正常
- 无 TypeScript 错误
- 无 console 警告或错误

---

## 八、测试与验证

### 1. 组件级测试

**每个组件完成后立即测试**：

#### EmployeeCard 测试清单
- [ ] 渲染正确的员工信息（姓名、头像、状态）
- [ ] 工作量显示正确（today 和 total）
- [ ] 状态图标正确显示（待查阅、等拍板、中断）
- [ ] 悬停动画流畅（scale 和 shadow）
- [ ] 点击卡片打开抽屉
- [ ] 响应式布局正常（380px 卡片在小屏幕下不溢出）
- [ ] 深色模式适配正确
- [ ] 减少动效模式下动画禁用

#### StatCard 测试清单
- [ ] 4 种渐变变体渲染正确
- [ ] 数字滚动动画流畅
- [ ] 趋势指示器显示正确
- [ ] 悬停效果正常
- [ ] 深色模式渐变可见

#### ToolApprovalDialog 测试清单
- [ ] 全屏渐变背景渲染
- [ ] 倒计时从 60 秒开始递减
- [ ] 倒计时归零自动拒绝
- [ ] 拒绝按钮默认焦点
- [ ] Enter 键触发拒绝（默认焦点）
- [ ] Escape 键关闭对话框
- [ ] 参数内容正确显示和截断
- [ ] 批准/拒绝回调正确触发

#### ConversationView 测试清单
- [ ] 消息气泡正确区分 user/assistant
- [ ] 流式输出正确渲染
- [ ] 工具调用卡片显示
- [ ] 自动滚动到最新消息
- [ ] 长消息正确换行
- [ ] 代码块正确高亮

#### AppSideNav 测试清单
- [ ] 导航项正确高亮当前路由
- [ ] 悬停动画流畅
- [ ] 点击导航项正确跳转
- [ ] Logo 呼吸动画流畅
- [ ] 键盘 Tab 导航正常
- [ ] 活动指示器跟随选中项

---

### 2. 页面级测试

#### HomePage 测试清单
- [ ] 统计卡片正确显示数据
- [ ] 员工卡片 3 列布局正确
- [ ] Staggered 入场动画流畅
- [ ] 页面渐变背景渲染
- [ ] 响应式布局正常（1200x800 和 960x640）
- [ ] 空状态正确显示（无员工时）

#### EmployeesPage 测试清单
- [ ] 网格视图正确显示 3 列
- [ ] 列表视图紧凑行正确
- [ ] 视图切换动画流畅
- [ ] 搜索功能正常
- [ ] 筛选器正常工作
- [ ] 大数据量渲染流畅（100+ 员工）

#### WorkRecordsPage 测试清单
- [ ] 时间轴卡片正确渲染
- [ ] 状态渐变背景正确
- [ ] 筛选器正常工作
- [ ] 分页功能正常
- [ ] 空状态正确显示

#### ArrangeWorkPage 测试清单
- [ ] 模式选择卡片正确显示
- [ ] 卡片选中状态正确
- [ ] 模式切换动画流畅
- [ ] 表单逻辑正常
- [ ] 提交流程正常

#### LoginPage 测试清单
- [ ] 渐变背景渲染
- [ ] 入场动画流畅
- [ ] 表单验证正常
- [ ] 登录流程正常
- [ ] 错误提示温和显示

---

### 3. 性能测试

**目标指标**：

| 指标 | 目标 | 测试方法 |
|------|------|----------|
| 首屏渲染 | < 1s | Lighthouse Performance Score > 90 |
| 动画帧率 | > 50 FPS | Chrome DevTools Performance 面板 |
| 内存占用 | < 200MB | Chrome DevTools Memory 面板 |
| Bundle 大小 | < 2MB | `npm run build` 输出 |

**测试步骤**：

1. **首屏渲染测试**
   ```bash
   npm run build
   npm run preview
   # 打开 Chrome DevTools > Lighthouse
   # 运行 Performance 测试
   ```

2. **动画性能测试**
   ```bash
   npm run dev
   # 打开 Chrome DevTools > Performance
   # 录制 HomePage 加载和滚动
   # 检查 FPS 曲线，目标 > 50 FPS
   ```

3. **内存测试**
   ```bash
   # 打开 Chrome DevTools > Memory
   # Take Heap Snapshot
   # 对比操作前后内存变化，目标增量 < 50MB
   ```

4. **Bundle 大小测试**
   ```bash
   npm run build
   # 检查 dist/ 输出
   # 主 chunk 应 < 1MB，总大小 < 2MB
   ```

---

### 4. 兼容性测试

**测试矩阵**：

| 分辨率 | 窗口大小 | 状态 |
|--------|----------|------|
| 标准模式 | 1200x800 | ✅ 必测 |
| 紧凑模式 | 960x640 | ✅ 必测 |
| 宽屏模式 | 1440x900 | ⚠️ 建议测试 |

| 操作系统 | 状态 |
|----------|------|
| macOS | ✅ 必测 |
| Windows | ✅ 必测 |
| Linux | ⚠️ 建议测试 |

| 主题 | 状态 |
|------|------|
| 浅色模式 | ✅ 必测 |
| 深色模式 | ✅ 必测 |

**测试步骤**：

1. **分辨率测试**
   ```bash
   # 打开应用，调整窗口大小
   # 检查布局是否正常，文字是否可读，按钮是否可点击
   # 3 列布局在 960x640 下应自动降级为 2 列
   ```

2. **深色模式测试**
   ```bash
   # 切换系统深色模式
   # 检查所有渐变、文字、边框是否可见
   # 颜色对比度应 > 4.5:1
   ```

---

### 5. 可访问性测试

**WCAG 2.1 AA 合规性**：

- [ ] **键盘导航**：所有交互元素可通过 Tab 访问
- [ ] **焦点指示器**：焦点状态清晰可见
- [ ] **颜色对比度**：文字对比度 > 4.5:1
- [ ] **减少动效**：`prefers-reduced-motion` 下动画禁用
- [ ] **屏幕阅读器**：所有图像和图标有 `aria-label`

**测试工具**：

1. **axe DevTools**（Chrome 扩展）
   ```bash
   # 安装 axe DevTools 扩展
   # 打开每个页面，运行 axe 扫描
   # 修复所有 Critical 和 Serious 问题
   ```

2. **键盘导航测试**
   ```bash
   # 不使用鼠标，仅用键盘操作应用
   # Tab / Shift+Tab：焦点移动
   # Enter / Space：激活按钮
   # Escape：关闭对话框
   # 方向键：列表导航
   ```

3. **屏幕阅读器测试**
   ```bash
   # macOS：启用 VoiceOver（Cmd+F5）
   # Windows：启用 Narrator（Win+Ctrl+Enter）
   # 检查所有元素是否正确朗读
   ```

---

### 6. 回滚计划

**如果方案 B 出现严重问题**：

1. **回滚步骤**
   ```bash
   git checkout main
   npm install
   npm run dev
   ```

2. **部分回滚**（保留某些改进）
   ```bash
   # 只回滚 CSS 变量
   git checkout main -- src/styles/enterprise.css

   # 只回滚特定组件
   git checkout main -- src/components/enterprise/EmployeeCard.tsx
   ```

3. **渐进式灰度**（生产环境）
   - 添加功能开关：`ENABLE_PLAN_B=true`
   - 用户可在设置中选择 UI 版本
   - 收集用户反馈后决定是否全量

---

## 九、上线检查清单

### 代码质量
- [ ] 所有 TypeScript 错误已修复
- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过
- [ ] 无 console.log 或 debugger 语句
- [ ] 所有 TODO 注释已清理或转为工单

### 功能完整性
- [ ] 所有 P0 和 P1 功能已实现
- [ ] 所有页面路由正常
- [ ] 所有组件测试通过
- [ ] IPC 通信正常（main ↔ renderer）
- [ ] 数据持久化正常（Zustand + localStorage）

### 性能达标
- [ ] Lighthouse Performance Score > 90
- [ ] 动画帧率 > 50 FPS
- [ ] 内存占用 < 200MB
- [ ] Bundle 大小 < 2MB

### 兼容性验证
- [ ] 1200x800 和 960x640 分辨率测试通过
- [ ] macOS 和 Windows 测试通过
- [ ] 浅色和深色模式测试通过

### 可访问性合规
- [ ] axe DevTools 扫描无 Critical 问题
- [ ] 键盘导航测试通过
- [ ] 颜色对比度 > 4.5:1
- [ ] `prefers-reduced-motion` 支持

### 文档完善
- [ ] CHANGELOG.md 更新
- [ ] README.md 更新（如有新依赖）
- [ ] 组件使用文档更新
- [ ] 设计系统文档更新

### 部署准备
- [ ] 生产构建成功（`npm run build`）
- [ ] 打包 Electron 应用成功
- [ ] 安装包在目标系统上可运行
- [ ] 自动更新流程测试通过

---

## 十、常见问题

### Q1: framer-motion 动画卡顿怎么办？

**原因**：动画过多或硬件加速未启用。

**解决方案**：
```typescript
// 1. 使用 layoutId 优化布局动画
<motion.div layoutId="unique-id" />

// 2. 启用硬件加速
<motion.div style={{ willChange: 'transform' }} />

// 3. 减少同时播放的动画数量
// 使用 stagger 替代同时触发
transition={{ staggerChildren: 0.1 }}

// 4. 降低动画复杂度
// 避免同时 scale + rotate + opacity
```

---

### Q2: 渐变背景在深色模式下不可见？

**原因**：深色模式 CSS 变量未定义。

**解决方案**：
```css
/* enterprise.css */
:root[data-theme='dark'] {
  --ent-gradient-warm: linear-gradient(135deg, #a94e22 0%, #c4612f 100%);
  --ent-gradient-sunset: linear-gradient(135deg, #a94e22 0%, #b85535 50%, #c4612f 100%);
}
```

---

### Q3: 员工卡片在小屏幕下溢出？

**原因**：380px 固定宽度不适配。

**解决方案**：
```typescript
// 响应式调整
<div className="grid grid-cols-3 gap-8 
  xl:grid-cols-3  /* 1280px+ 3 列 */
  lg:grid-cols-2  /* 1024px-1280px 2 列 */
  md:grid-cols-1  /* < 1024px 1 列 */
">
```

---

### Q4: 字体加载失败？

**原因**：网络问题或 Google Fonts 被墙。

**解决方案**：
```html
<!-- 1. 使用国内 CDN -->
<link href="https://fonts.loli.net/css2?family=Fraunces:wght@400;600&display=swap" rel="stylesheet">

<!-- 2. 或自托管字体 -->
<!-- 下载 Fraunces.woff2 到 src/assets/fonts/ -->
```

```css
/* enterprise.css */
@font-face {
  font-family: 'Fraunces';
  src: url('/src/assets/fonts/Fraunces-Regular.woff2') format('woff2');
  font-weight: 400;
  font-display: swap;
}
```

---

### Q5: TypeScript 报错 `Module '"framer-motion"' has no exported member 'motion'`？

**原因**：framer-motion 版本问题或类型未安装。

**解决方案**：
```bash
# 重新安装
npm uninstall framer-motion
npm install framer-motion@latest

# 清理缓存
rm -rf node_modules package-lock.json
npm install
```

---

### Q6: 动画在 `prefers-reduced-motion` 下仍然播放？

**原因**：未正确检测或禁用。

**解决方案**：
```typescript
// 创建全局 hook
// src/hooks/useReducedMotion.ts
import { useEffect, useState } from 'react';

export function useReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mediaQuery.matches);

    const listener = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion(e.matches);
    };

    mediaQuery.addEventListener('change', listener);
    return () => mediaQuery.removeEventListener('change', listener);
  }, []);

  return prefersReducedMotion;
}

// 在组件中使用
const shouldReduceMotion = useReducedMotion();

<motion.div
  animate={shouldReduceMotion ? {} : { scale: 1.05 }}
/>
```

---

## 十一、附录

### A. 参考资源

**设计灵感**：
- Beautiful UI: https://beautifului.dev/
- Aceternity UI: https://ui.aceternity.com/
- Magic UI: https://magicui.design/

**组件库**：
- shadcn/ui: https://ui.shadcn.com/
- Radix UI: https://www.radix-ui.com/
- Framer Motion: https://www.framer.com/motion/

**工具**：
- Embla Carousel: https://www.embla-carousel.com/
- Recharts: https://recharts.org/
- Lucide Icons: https://lucide.dev/

**测试**：
- axe DevTools: https://www.deque.com/axe/devtools/
- Lighthouse: https://developer.chrome.com/docs/lighthouse/
- React Testing Library: https://testing-library.com/react

---

### B. 颜色变量速查表

| 变量名 | 浅色模式值 | 深色模式值 | 用途 |
|--------|-----------|-----------|------|
| `--ent-terracotta` | `#c4612f` | `#a94e22` | 主色 |
| `--ent-terracotta-hover` | `#a94e22` | `#8d3e1c` | 悬停态 |
| `--ent-cream` | `#f7f4ef` | `#1f2421` | 背景 |
| `--ent-gradient-warm` | `from-terracotta to-orange-600` | `from-[#a94e22] to-[#c4612f]` | 暖色渐变 |
| `--ent-gradient-sunset` | `from-terracotta via-orange-500 to-orange-600` | - | 日落渐变 |
| `--ent-gradient-cool` | `from-blue-500 to-cyan-500` | - | 冷色渐变 |
| `--ent-gradient-neutral` | `from-gray-400 to-gray-600` | - | 中性渐变 |

---

### C. 动画时长速查表

| 场景 | 时长 | 缓动函数 |
|------|------|---------|
| 按钮悬停 | 200ms | `ease-out` |
| 卡片悬停 | 300ms | `ease-out` |
| 页面切换 | 400ms | `ease-in-out` |
| 对话框打开 | 500ms | `spring` |
| 数字滚动 | 600ms | `ease-out` |
| Logo 呼吸 | 2000ms | `ease-in-out` (loop) |

---

### D. 响应式断点

```typescript
// tailwind.config.js（如果使用配置文件）
export default {
  theme: {
    screens: {
      sm: '640px',   // 小屏幕（不常用）
      md: '960px',   // 紧凑模式
      lg: '1200px',  // 标准模式
      xl: '1440px',  // 宽屏模式
    },
  },
};
```

---

### E. Git Commit 示例

```bash
# 特性提交
git commit -m "feat(ui): upgrade EmployeeCard to Plan B showcase style

- Increase card size from 160px to 380px
- Add gradient background and shadow
- Implement hover scale animation
- Add work statistics display

Closes #123"

# 修复提交
git commit -m "fix(animation): disable animations when prefers-reduced-motion

- Add useReducedMotion hook
- Conditionally disable framer-motion animations
- Update all motion.div components

Fixes #124"

# 样式提交
git commit -m "style(css): update CSS variables for Plan B design system

- Change --ent-radius-md from 10px to 12px
- Add gradient color variables
- Update font size from 13px to 15px
- Add serif font family"
```

---

## 十二、总结

本文档提供了 **方案 B（视觉叙事风格）** 的完整实施指南，覆盖：

✅ **项目概览**：当前状态分析，技术栈验证  
✅ **依赖安装**：framer-motion, embla-carousel-react, recharts  
✅ **设计系统升级**：CSS 变量、字体、颜色、间距、圆角、动画  
✅ **组件实现**：5 个核心组件的完整代码和迁移清单  
✅ **页面实现**：4 个核心页面的结构和实施要点  
✅ **实施优先级**：P0/P1/P2 分阶段实施，时间估算  
✅ **测试验证**：组件级、页面级、性能、兼容性、可访问性测试  
✅ **上线清单**：代码质量、功能完整性、性能、文档  
✅ **常见问题**：动画卡顿、渐变失效、字体加载等问题解决  
✅ **附录资源**：设计参考、颜色变量、动画时长、响应式断点

**下一步行动**：

1. **立即启动 P0**：安装依赖 + 更新 CSS 变量（2 小时内完成）
2. **P1 并行开发**：EmployeeCard + StatCard + ToolApprovalDialog（3-5 天）
3. **P2 顺序集成**：HomePage → EmployeesPage → WorkRecordsPage（5-7 天）
4. **全面测试**：性能 + 兼容性 + 可访问性（2-3 天）
5. **上线发布**：完成检查清单 + 部署（1 天）

**预计总工期**：**10-15 天**（1 位开发者全职投入）

---

**最后更新**: 2026-09-21  
**文档版本**: v1.0  
**适用项目**: sep-client (Silicon Employee Platform Client)  
**技术栈**: Electron 33 + React 18 + TypeScript 5.6 + Tailwind CSS 4 + framer-motion