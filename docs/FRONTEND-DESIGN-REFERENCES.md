# SEP Client 前端设计参考指南

> 针对 sep-client（硅基员工平台 Electron 客户端）所有页面和组件的开源/免费设计参考资源

## 📋 目录

- [核心页面](#核心页面)
- [企业工作台页面](#企业工作台页面)
- [对话和交互组件](#对话和交互组件)
- [UI 基础组件](#ui-基础组件)
- [布局和导航](#布局和导航)
- [设计系统和工具](#设计系统和工具)

---

## 核心页面

### 1. 登录页面 (`LoginPage.tsx`)

**功能**：邮箱密码登录、记住账号、账号历史选择

**参考资源**：

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **Tailwind UI - Login Forms** | https://tailwindui.com/components/application-ui/forms/sign-in-forms | 完整的登录表单，免费示例可用 |
| **shadcn/ui - Login Form** | https://ui.shadcn.com/examples/authentication | 基于 Radix + Tailwind 的登录表单 |
| **Flowbite - Sign In** | https://flowbite.com/blocks/marketing/login/ | 免费开源的登录页面组件 |
| **DaisyUI - Login** | https://daisyui.com/components/form/#login-form | Tailwind CSS 组件库 |
| **Hyperui - Authentication** | https://www.hyperui.dev/components/application-ui/authentication | 完全免费，多种登录布局 |

**设计要点**：
- 账号历史下拉选择器（带头像、邮箱、删除按钮）
- 密码显示/隐藏切换
- 记住密码复选框 + safeStorage 加密提示
- 加载状态和错误提示
- 渐变背景 + 磨砂玻璃效果

**代码参考**：
```typescript
// shadcn/ui 登录表单基础
https://github.com/shadcn-ui/ui/tree/main/apps/www/app/examples/authentication

// Clerk 开源登录组件
https://github.com/clerk/javascript/tree/main/packages/clerk-js/src/ui/components
```

---

### 2. 首页 - 员工概览 (`HomePage.tsx`)

**功能**：员工卡片墙（可横向滚动环形布局）、统计卡片、派活输入框

**参考资源**：

#### 2.1 卡片墙 / 环形轮播

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **Embla Carousel** | https://www.embla-carousel.com/ | 轻量级、无依赖的轮播库 |
| **Swiper** | https://swiperjs.com/ | 功能强大的触摸滑动库 |
| **Keen Slider** | https://keen-slider.io/ | 性能优异的原生 JS 滑块 |
| **Framer Motion - Carousel** | https://www.framer.com/motion/examples/#carousel | React 动画库实现的轮播 |

**开源实现**：
```typescript
// 环形轮播实现参考
https://github.com/davidjerleke/embla-carousel/blob/master/examples/loop/

// 横向滚动 + 渐隐边缘
https://github.com/pacocoursey/next-themes/blob/main/examples/
```

#### 2.2 员工卡片设计

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **BeautifulUI - Profile Cards** | https://beautifului.dev/ | 精致的个人信息卡片 |
| **Aceternity UI - Hover Cards** | https://ui.aceternity.com/components/hover-effect | 动态悬停效果 |
| **Magic UI - Bento Grid** | https://magicui.design/docs/components/bento-grid | 网格卡片布局 |
| **Pines - Team Cards** | https://devdojo.com/pines/docs/team-cards | Alpine.js + Tailwind 团队卡片 |

**设计要点**：
- 员工头像 + 姓名 + 状态指示器（工作中/空闲/不可用）
- 今日工作量（完成数/总数）
- 状态图标（待查阅、等拍板、中断）
- 卡片点击打开抽屉

**Figma 资源**（可参考布局）：
- **Untitled UI** (免费): https://www.untitledui.com/
- **Ant Design Figma**: https://www.figma.com/community/file/831698976089873405

#### 2.3 统计卡片

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **Tremor** | https://www.tremor.so/ | React 数据可视化组件库 |
| **shadcn/ui - Cards** | https://ui.shadcn.com/docs/components/card | 基础卡片组件 |
| **React Aria - Card** | https://react-spectrum.adobe.com/react-aria/Card.html | Adobe 的可访问卡片组件 |

---

### 3. 员工列表页 (`EmployeesPage.tsx`)

**功能**：搜索、筛选、卡片/列表视图切换、虚拟滚动

**参考资源**：

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **TanStack Virtual** | https://tanstack.com/virtual/latest | 高性能虚拟滚动（项目已用） |
| **shadcn/ui - Data Table** | https://ui.shadcn.com/docs/components/data-table | 表格 + 搜索 + 筛选 |
| **Mantine - Table** | https://mantine.dev/core/table/ | 功能完整的表格组件 |
| **React Email - Templates** | https://react.email/examples | 卡片布局参考 |

**工具栏设计参考**：
```typescript
// Segment Control（范围切换）
https://ui.shadcn.com/docs/components/tabs

// 搜索框
https://ui.shadcn.com/docs/components/command

// 视图切换按钮
https://heroicons.com/ (图标)
https://lucide.dev/ (项目已用)
```

---

### 4. 对话页面 (`ConversationView.tsx`)

**功能**：消息列表、流式输出、工具调用显示、滚动到底部

**参考资源**：

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **Vercel AI SDK UI** | https://sdk.vercel.ai/docs/ai-sdk-ui | 官方 AI 聊天 UI 参考 |
| **ChatGPT UI Clone** | https://github.com/mckaywrigley/chatbot-ui | 开源 ChatGPT 界面 |
| **Dub.co Chat** | https://github.com/dubinc/dub | Dub 的 AI 助手界面 |
| **Lobe Chat** | https://github.com/lobehub/lobe-chat | 功能完整的 AI 聊天客户端 |
| **Chatbox** | https://github.com/Bin-Huang/chatbox | Electron + OpenAI 聊天应用 |

**消息气泡设计**：
```typescript
// shadcn/ui 聊天组件（社区贡献）
https://ui.shadcn.com/docs/components/chat

// React Chat Elements
https://github.com/Detaysoft/react-chat-elements

// Stream Chat React
https://getstream.io/chat/docs/sdk/react/
```

**设计要点**：
- 用户消息（右侧、背景色）vs AI 消息（左侧、白色）
- 头像 + 姓名 + 模型标识
- 流式输出动画（打字机效果）
- 工具调用状态（扳手图标 + 活动描述）
- 错误和暂停提示
- 自动滚动到底部 + "回到底部"按钮

---

### 5. 工具审批对话框 (`ToolApprovalDialog.tsx`)

**功能**：显示工具名称和参数、批准/拒绝、60 秒倒计时

**参考资源**：

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **shadcn/ui - Alert Dialog** | https://ui.shadcn.com/docs/components/alert-dialog | 模态确认对话框 |
| **Radix UI - Dialog** | https://www.radix-ui.com/themes/docs/components/dialog | 无样式对话框原语 |
| **Headless UI - Dialog** | https://headlessui.com/react/dialog | Tailwind Labs 的对话框 |
| **Chakra UI - Modal** | https://chakra-ui.com/docs/components/modal | 功能完整的模态框 |

**安全提示设计参考**：
```typescript
// Vercel - Security Alert
https://vercel.com/design/alert

// GitHub - Danger Zone
https://primer.style/react/Banner

// Stripe - Confirmation Dialog
https://stripe.com/docs/elements
```

**设计要点**：
- 警告色系（橙色/红色）
- 风险提示框（背景色 + 边框 + 图标）
- 倒计时显示（大号数字 + "自动拒绝"文字）
- 参数内容展示（代码块 + 截断长文本）
- 拒绝按钮默认焦点（安全设计）

---

## 企业工作台页面

### 6. 安排工作页面 (`ArrangeWorkPage.tsx`)

**功能**：多步骤工作流编排、依赖关系、员工分配

**参考资源**：

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **React Flow** | https://reactflow.dev/ | 流程图和节点编辑器 |
| **Xyflow** | https://www.xyflow.com/ | React Flow 的升级版 |
| **Excalidraw** | https://github.com/excalidraw/excalidraw | 白板式流程图 |
| **Mermaid** | https://mermaid.js.org/ | 文本驱动的流程图 |

**步骤编辑器参考**：
```typescript
// Linear - Issue Editor
https://linear.app/ (参考交互)

// Notion - Blocks
https://www.notion.so/ (参考拖拽排序)

// Asana - Task Dependencies
https://asana.com/ (参考依赖关系)
```

---

### 7. 工作详情页 (`WorkDetailPage.tsx`)

**功能**：工作元信息、步骤列表、参与人员、状态流转

**参考资源**：

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **GitHub Issue Page** | https://github.com/ | 状态流转、评论、参与者 |
| **Linear Issue View** | https://linear.app/ | 简洁的详情页布局 |
| **Jira Ticket** | https://www.atlassian.com/software/jira | 复杂的工单系统 |
| **Notion Page** | https://www.notion.so/ | 灵活的内容展示 |

**时间轴组件**：
```typescript
// shadcn/ui Timeline (社区)
https://ui.shadcn.com/docs/components/timeline

// React Vertical Timeline
https://github.com/stephane-monnot/react-vertical-timeline

// Tremor - Tracker
https://www.tremor.so/docs/visualizations/tracker
```

---

### 8. 工作记录页 (`WorkRecordsPage.tsx`)

**功能**：历史工作列表、搜索、状态筛选、分页

**参考资源**：

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **shadcn/ui - Data Table** | https://ui.shadcn.com/docs/components/data-table | 完整的表格示例 |
| **TanStack Table** | https://tanstack.com/table/latest | 无样式表格库 |
| **AG Grid** | https://www.ag-grid.com/ | 企业级表格（社区版免费） |
| **React Table** | https://react-table-v7.tanstack.com/ | 轻量级表格 |

---

## 对话和交互组件

### 9. 派活输入框 (`ArrangeBar.tsx`)

**功能**：多行文本输入、工作场地选择、实时反馈

**参考资源**：

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **Slack Message Input** | https://slack.com/ | 参考交互设计 |
| **Discord Text Box** | https://discord.com/ | 富文本输入框 |
| **Tiptap Editor** | https://tiptap.dev/ | 可扩展的富文本编辑器 |
| **Lexical** | https://lexical.dev/ | Meta 的编辑器框架 |

**底部固定栏设计**：
```typescript
// shadcn/ui - Textarea
https://ui.shadcn.com/docs/components/textarea

// Floating UI
https://floating-ui.com/ (工具提示定位)

// Radix UI - Toolbar
https://www.radix-ui.com/themes/docs/components/toolbar
```

---

### 10. 员工抽屉 (`EmployeeWorksDrawer.tsx`)

**功能**：侧边滑出、员工信息、历史工作列表

**参考资源**：

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **shadcn/ui - Sheet** | https://ui.shadcn.com/docs/components/sheet | 侧边抽屉组件 |
| **Radix UI - Dialog** | https://www.radix-ui.com/themes/docs/components/dialog | 可改造为抽屉 |
| **Headless UI - Slide Over** | https://headlessui.com/react/dialog#with-slide-over | 官方滑出面板示例 |
| **Mantine - Drawer** | https://mantine.dev/core/drawer/ | 功能完整的抽屉 |

**动画参考**：
```typescript
// Framer Motion - Slide
https://www.framer.com/motion/animation/#slide

// React Spring - Drawer
https://www.react-spring.dev/

// Tailwind CSS - Transitions
https://tailwindcss.com/docs/transition-property
```

---

### 11. 工作计划抽屉 (`WorkPlanDrawer.tsx`)

**功能**：展示工作计划、步骤列表、依赖关系

**参考资源**：同 #10 抽屉组件 + 时间轴组件

---

## UI 基础组件

### 12. 按钮组件 (`Button.tsx`)

**参考资源**：

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **shadcn/ui - Button** | https://ui.shadcn.com/docs/components/button | 完整的按钮变体 |
| **Radix UI - Button** | https://www.radix-ui.com/themes/docs/components/button | 无样式按钮原语 |
| **React Aria - Button** | https://react-spectrum.adobe.com/react-aria/Button.html | 可访问性按钮 |
| **Tailwind UI - Buttons** | https://tailwindui.com/components/application-ui/elements/buttons | 多种按钮样式 |

**变体参考**：
- Primary (主按钮)
- Secondary (次按钮)
- Ghost (幽灵按钮)
- Danger (危险操作)
- Icon (图标按钮)
- Loading (加载状态)

---

### 13. 输入框组件 (`Input.tsx`)

**参考资源**：

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **shadcn/ui - Input** | https://ui.shadcn.com/docs/components/input | 基础输入框 |
| **Radix UI - TextField** | https://www.radix-ui.com/themes/docs/components/text-field | 文本字段组件 |
| **Headless UI - Combobox** | https://headlessui.com/react/combobox | 自动补全输入框 |
| **React Hook Form** | https://react-hook-form.com/ | 表单验证库 |

---

### 14. 空状态组件 (`Empty` in `atoms.tsx`)

**参考资源**：

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **shadcn/ui - Empty States** | https://ui.shadcn.com/examples | 查看示例页面 |
| **Undraw Illustrations** | https://undraw.co/ | 免费插图 |
| **Lucide Icons** | https://lucide.dev/ | 项目已用的图标库 |
| **Empty States Design** | https://emptystat.es/ | 空状态设计灵感 |

---

### 15. 骨架屏 (`Skeleton.tsx`)

**参考资源**：

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **shadcn/ui - Skeleton** | https://ui.shadcn.com/docs/components/skeleton | 加载占位符 |
| **React Content Loader** | https://github.com/danilowoz/react-content-loader | 自定义骨架屏 |
| **React Loading Skeleton** | https://github.com/dvtng/react-loading-skeleton | 简单易用的骨架屏 |

---

### 16. 虚拟列表 (`VirtualList.tsx`)

**参考资源**：

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **TanStack Virtual** | https://tanstack.com/virtual/latest | 项目已用 |
| **React Window** | https://github.com/bvaughn/react-window | 轻量级虚拟滚动 |
| **React Virtuoso** | https://virtuoso.dev/ | 功能强大的虚拟滚动 |

---

## 布局和导航

### 17. 顶部导航栏 (`AppTopBar.tsx`)

**参考资源**：

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **Tailwind UI - Headers** | https://tailwindui.com/components/application-ui/navigation/navbars | 多种导航栏布局 |
| **shadcn/ui - Navigation Menu** | https://ui.shadcn.com/docs/components/navigation-menu | 下拉导航菜单 |
| **Radix UI - Navigation Menu** | https://www.radix-ui.com/themes/docs/components/navigation-menu | 无样式导航原语 |

**Electron 特殊考虑**：
- 拖拽区域（`-webkit-app-region: drag`）
- 窗口控制按钮（最小化、最大化、关闭）
- macOS 红绿灯位置

---

### 18. 侧边导航栏 (`AppSideNav.tsx`)

**参考资源**：

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **Tailwind UI - Sidebar** | https://tailwindui.com/components/application-ui/navigation/sidebar-navigation | 完整的侧边栏 |
| **VS Code Sidebar** | https://code.visualstudio.com/ | 参考 Electron 应用 |
| **Figma Sidebar** | https://www.figma.com/ | 参考设计工具 |

---

### 19. 账号菜单 (`AccountMenu.tsx`)

**参考资源**：

| 资源 | 链接 | 适用场景 |
|------|------|----------|
| **shadcn/ui - Dropdown Menu** | https://ui.shadcn.com/docs/components/dropdown-menu | 下拉菜单 |
| **Radix UI - Dropdown Menu** | https://www.radix-ui.com/themes/docs/components/dropdown-menu | 无样式下拉菜单 |
| **Headless UI - Menu** | https://headlessui.com/react/menu | Tailwind Labs 的菜单 |

---

## 设计系统和工具

### 20. 完整的开源设计系统

| 设计系统 | 链接 | 特点 |
|----------|------|------|
| **shadcn/ui** | https://ui.shadcn.com/ | Radix + Tailwind，复制即用 ⭐️ |
| **Radix Themes** | https://www.radix-ui.com/themes | 完整的设计系统 |
| **Park UI** | https://park-ui.com/ | Ark UI + Panda CSS |
| **Mantine** | https://mantine.dev/ | 功能丰富的 React 组件库 |
| **Chakra UI** | https://chakra-ui.com/ | 可定制的组件系统 |
| **DaisyUI** | https://daisyui.com/ | Tailwind CSS 插件 |
| **Flowbite** | https://flowbite.com/ | Tailwind 组件库 |
| **Headless UI** | https://headlessui.com/ | Tailwind Labs 官方 |
| **React Aria** | https://react-spectrum.adobe.com/react-aria/ | Adobe 的可访问性组件 |

### 21. 图标库

| 图标库 | 链接 | 特点 |
|--------|------|------|
| **Lucide** | https://lucide.dev/ | 项目已用 ⭐️ |
| **Heroicons** | https://heroicons.com/ | Tailwind Labs 出品 |
| **Phosphor Icons** | https://phosphoricons.com/ | 灵活的图标系统 |
| **Tabler Icons** | https://tabler.io/icons | 4000+ 开源图标 |
| **Feather Icons** | https://feathericons.com/ | 简洁的图标集 |

### 22. 动画库

| 动画库 | 链接 | 特点 |
|--------|------|------|
| **Framer Motion** | https://www.framer.com/motion/ | 强大的 React 动画库 |
| **React Spring** | https://www.react-spring.dev/ | 弹簧物理动画 |
| **Auto Animate** | https://auto-animate.formkit.com/ | 自动添加过渡动画 |
| **GSAP** | https://gsap.com/ | 专业级动画库 |

### 23. 颜色和主题

| 工具 | 链接 | 用途 |
|------|------|------|
| **Radix Colors** | https://www.radix-ui.com/colors | 可访问的调色板系统 |
| **Tailwind Color Palette** | https://tailwindcss.com/docs/customizing-colors | Tailwind 默认色板 |
| **Realtime Colors** | https://www.realtimecolors.com/ | 实时预览配色 |
| **Coolors** | https://coolors.co/ | 配色方案生成器 |
| **UI Colors** | https://uicolors.app/ | Tailwind 配色生成 |

### 24. 字体

| 字体 | 链接 | 用途 |
|------|------|------|
| **Inter** | https://rsms.me/inter/ | 项目已用，UI 字体 |
| **思源黑体** | https://github.com/adobe-fonts/source-han-sans | 中文无衬线字体 |
| **阿里巴巴普惠体** | https://www.alibabafonts.com/ | 免费中文字体 |
| **霞鹜文楷** | https://github.com/lxgw/LxgwWenKai | 开源楷体 |

### 25. Figma / 设计资源

| 资源 | 链接 | 用途 |
|------|------|------|
| **Untitled UI** | https://www.untitledui.com/ | 免费 Figma 设计系统 |
| **Ant Design Figma** | https://www.figma.com/community/file/831698976089873405 | Ant Design 官方 |
| **Material Design** | https://m3.material.io/ | Google 设计系统 |
| **Figma Community** | https://www.figma.com/community | 海量免费资源 |

---

## 💡 实施建议

### 按优先级分阶段参考

#### P0 - 立即可用的基础组件
1. **shadcn/ui** - 直接复制所有基础组件（Button, Input, Dialog, Sheet, Card）
2. **Lucide Icons** - 已集成，继续使用
3. **Radix Colors** - 统一配色系统

#### P1 - 核心交互组件
1. **Embla Carousel** - 员工卡片墙的环形轮播
2. **Framer Motion** - 过渡动画（抽屉、对话框、消息）
3. **TanStack Virtual** - 已集成，优化长列表

#### P2 - 高级功能组件
1. **React Flow** - 工作流编排可视化
2. **Tiptap / Lexical** - 富文本输入（如需要）
3. **AG Grid** - 复杂表格（如需要）

### 设计规范建议

**颜色系统**（基于项目 `enterprise.css`）：
```css
/* 主色调 - 紫蓝色 */
--primary: 99 102 241;     /* #6366f1 */
--primary-hover: 79 70 229; /* #4f46e5 */

/* 中性色 - 暖灰 */
--neutral-50: 247 248 252;
--neutral-900: 38 35 36;

/* 语义色 */
--success: 34 197 94;      /* 绿色 */
--warning: 234 179 8;      /* 黄色 */
--danger: 239 68 68;       /* 红色 */
```

**间距系统**（Tailwind 默认）：
```
4px (1), 8px (2), 12px (3), 16px (4), 
20px (5), 24px (6), 32px (8), 48px (12)
```

**圆角**：
```
小: 6px (rounded-md)
中: 8px (rounded-lg)
大: 12px (rounded-xl)
全圆: 9999px (rounded-full)
```

**阴影**：
```
卡片: shadow-sm
悬浮: shadow-md
对话框: shadow-2xl
```

### 可访问性（WCAG 2.1 AA）

所有参考资源都应满足：
- ✅ 键盘导航（Tab, Enter, Escape, 方向键）
- ✅ 屏幕阅读器支持（aria-label, role, aria-describedby）
- ✅ 颜色对比度 4.5:1（正文）/ 3:1（大文本）
- ✅ 焦点指示器（focus-visible:ring）
- ✅ 减少动效（prefers-reduced-motion）

---

## 🔗 快速链接集合

**一站式参考**：
```
shadcn/ui:     https://ui.shadcn.com/
Radix UI:      https://www.radix-ui.com/
Tailwind UI:   https://tailwindui.com/
Flowbite:      https://flowbite.com/
Hyperui:       https://www.hyperui.dev/
Aceternity UI: https://ui.aceternity.com/
Magic UI:      https://magicui.design/
```

**Electron 应用参考**：
```
VS Code:       https://github.com/microsoft/vscode
Figma:         https://www.figma.com/
Discord:       https://discord.com/
Slack:         https://slack.com/
Obsidian:      https://obsidian.md/
```

**AI 聊天界面参考**：
```
ChatGPT UI:    https://github.com/mckaywrigley/chatbot-ui
Lobe Chat:     https://github.com/lobehub/lobe-chat
Chatbox:       https://github.com/Bin-Huang/chatbox
Vercel AI:     https://sdk.vercel.ai/
```

---

## 📝 更新日志

- 2026-09-21: 初始版本，覆盖所有核心页面和组件
