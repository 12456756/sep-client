# 组件设计映射表

> 快速查找：每个组件应该去哪个网站找参考

## 📊 按组件类型查找

### 🎨 卡片类组件

| 组件 | 最佳参考网站 | 直接链接 |
|------|------------|---------|
| **EmployeeCard** | BeautifulUI | https://beautifului.dev/ (搜索 "profile card") |
| **EmployeeDeskCard** | Aceternity UI | https://ui.aceternity.com/components/hover-effect |
| **StatCard** | Tremor | https://www.tremor.so/docs/visualizations/card |
| **ModeCards** | Magic UI | https://magicui.design/docs/components/bento-grid |

**操作步骤**：
1. 打开 BeautifulUI 或 Aceternity UI
2. 找到 Profile Card / Hover Card 示例
3. 查看代码（通常可以直接复制）
4. 适配到项目的 Tailwind + Radix 栈

---

### 💬 对话类组件

| 组件 | 最佳参考网站 | 直接链接 |
|------|------------|---------|
| **ConversationView** | Vercel AI SDK | https://sdk.vercel.ai/docs/ai-sdk-ui/chatbot |
| **WorkspaceComposer** | shadcn/ui Chat | https://ui.shadcn.com/docs/components/chat |
| **MessageBubble** | Lobe Chat | https://github.com/lobehub/lobe-chat |

**快速上手**：
```bash
# 安装 Vercel AI SDK UI（可选）
npm install ai

# 查看 shadcn/ui 聊天组件
npx shadcn-ui@latest add chat

# 参考 Lobe Chat 的消息气泡样式
# https://github.com/lobehub/lobe-chat/tree/main/src/app/chat
```

---

### 📝 表单和输入

| 组件 | 最佳参考网站 | 直接链接 |
|------|------------|---------|
| **LoginPage** | Hyperui | https://www.hyperui.dev/components/application-ui/authentication |
| **ArrangeBar** | shadcn/ui Textarea | https://ui.shadcn.com/docs/components/textarea |
| **GoalComposer** | Tiptap | https://tiptap.dev/examples/default |
| **Input** | Radix UI | https://www.radix-ui.com/themes/docs/components/text-field |

**推荐流程**：
1. **LoginPage**: 先看 Hyperui 的完整登录表单，再从 shadcn/ui 拿输入框组件
2. **ArrangeBar**: 直接用 shadcn/ui 的 Textarea，添加自定义工具栏
3. **富文本编辑**: 如果需要格式化输入，用 Tiptap

---

### 🗂️ 列表和表格

| 组件 | 最佳参考网站 | 直接链接 |
|------|------------|---------|
| **EmployeesPage** | shadcn/ui Data Table | https://ui.shadcn.com/docs/components/data-table |
| **WorkRecordsPage** | TanStack Table | https://tanstack.com/table/latest |
| **VirtualList** | TanStack Virtual | https://tanstack.com/virtual/latest (已集成) |

**性能优化**：
- 少于 20 项：普通列表
- 20-100 项：考虑虚拟滚动
- 100+ 项：必须用虚拟滚动

---

### 🎭 模态框和抽屉

| 组件 | 最佳参考网站 | 直接链接 |
|------|------------|---------|
| **ToolApprovalDialog** | shadcn/ui Alert Dialog | https://ui.shadcn.com/docs/components/alert-dialog |
| **EmployeeWorksDrawer** | shadcn/ui Sheet | https://ui.shadcn.com/docs/components/sheet |
| **WorkPlanDrawer** | Headless UI Slide Over | https://headlessui.com/react/dialog#with-slide-over |
| **RunSettingsDrawer** | Mantine Drawer | https://mantine.dev/core/drawer/ |

**选择建议**：
- **确认操作** → Alert Dialog
- **查看详情** → Sheet / Drawer
- **复杂表单** → Full Dialog

---

### 🎠 轮播和滚动

| 组件 | 最佳参考网站 | 直接链接 |
|------|------------|---------|
| **员工卡片墙** | Embla Carousel | https://www.embla-carousel.com/examples/predefined/ |
| **技能列表横滚** | Keen Slider | https://keen-slider.io/examples |

**实现方案**：

#### 员工卡片墙（环形轮播）
```bash
# 安装 Embla Carousel
npm install embla-carousel-react

# 使用无限循环模式
https://www.embla-carousel.com/examples/predefined/#loop
```

**配置示例**：
```typescript
import useEmblaCarousel from 'embla-carousel-react'

const [emblaRef] = useEmblaCarousel({ 
  loop: true,           // 无限循环
  align: 'start',       // 对齐方式
  skipSnaps: false,     // 不跳过对齐点
  dragFree: false,      // 滑动后对齐
})
```

---

### 🧭 导航组件

| 组件 | 最佳参考网站 | 直接链接 |
|------|------------|---------|
| **AppTopBar** | Tailwind UI Navbar | https://tailwindui.com/components/application-ui/navigation/navbars |
| **AppSideNav** | shadcn/ui Sidebar | https://ui.shadcn.com/docs/components/sidebar |
| **AppNavBar** | Radix Navigation | https://www.radix-ui.com/themes/docs/components/navigation-menu |
| **AccountMenu** | shadcn/ui Dropdown | https://ui.shadcn.com/docs/components/dropdown-menu |

**Electron 特殊处理**：
```css
/* 顶部拖拽区域 */
.electron-drag-region {
  -webkit-app-region: drag;
  height: 40px; /* macOS 标准高度 */
}

/* 按钮需要排除拖拽 */
.electron-drag-region button {
  -webkit-app-region: no-drag;
}
```

---

### 🎯 状态和反馈

| 组件 | 最佳参考网站 | 直接链接 |
|------|------------|---------|
| **Empty State** | Undraw | https://undraw.co/ (免费插图) |
| **Skeleton** | shadcn/ui | https://ui.shadcn.com/docs/components/skeleton |
| **Loading** | Lucide Icons | https://lucide.dev/ (已集成) |
| **Toast** | shadcn/ui Sonner | https://ui.shadcn.com/docs/components/sonner |

---

### 📊 数据可视化

| 组件 | 最佳参考网站 | 直接链接 |
|------|------------|---------|
| **工作量统计** | Tremor | https://www.tremor.so/docs/visualizations/bar-chart |
| **时间轴** | React Vertical Timeline | https://github.com/stephane-monnot/react-vertical-timeline |
| **进度条** | shadcn/ui Progress | https://ui.shadcn.com/docs/components/progress |

---

## 🎨 按设计风格查找

### 极简风格
- **shadcn/ui**: https://ui.shadcn.com/
- **Radix Themes**: https://www.radix-ui.com/themes
- **Park UI**: https://park-ui.com/

### 现代商务风
- **Tailwind UI**: https://tailwindui.com/
- **Flowbite**: https://flowbite.com/
- **Tremor**: https://www.tremor.so/

### 科技感 / 未来感
- **Aceternity UI**: https://ui.aceternity.com/
- **Magic UI**: https://magicui.design/
- **BeautifulUI**: https://beautifului.dev/

### 企业级 / 传统
- **Ant Design**: https://ant.design/
- **Mantine**: https://mantine.dev/
- **Chakra UI**: https://chakra-ui.com/

---

## 🔧 按技术栈查找

### Tailwind CSS + Radix UI（项目技术栈）
1. **shadcn/ui** ⭐️ - 第一选择，直接复制代码
2. **Radix Themes** - 官方主题系统
3. **Park UI** - Ark UI + Panda CSS，但可借鉴设计

### React 动画
1. **Framer Motion** - 推荐用于页面过渡、抽屉滑入
2. **Auto Animate** - 自动过渡，极简集成
3. **React Spring** - 复杂物理动画

### Electron 桌面应用
1. **VS Code** - 参考侧边栏、标签页、命令面板
2. **Figma** - 参考工具栏、属性面板
3. **Discord** - 参考聊天界面、侧边栏

---

## 📱 响应式断点参考

```typescript
// Tailwind 默认断点（项目已用）
const breakpoints = {
  sm: '640px',   // 手机横屏
  md: '768px',   // 平板竖屏
  lg: '1024px',  // 平板横屏 / 小笔记本
  xl: '1280px',  // 笔记本
  '2xl': '1536px' // 大屏显示器
}

// Electron 桌口常见窗口尺寸
const commonSizes = {
  compact: '960x640',   // 紧凑模式
  standard: '1200x800', // 标准模式（项目要求）
  comfortable: '1440x900', // 舒适模式
}
```

---

## 🎯 实战案例：如何为某个组件找参考

### 案例 1：改进员工卡片设计

**需求**：员工卡片需要更吸引人的悬停效果

**步骤**：

1. **浏览灵感站点**：
   ```
   → BeautifulUI (https://beautifului.dev/)
   → 搜索 "profile" 或 "team"
   → 找到 3-5 个喜欢的设计
   ```

2. **查看实现**：
   ```
   → Aceternity UI Hover Card
   → https://ui.aceternity.com/components/hover-effect
   → 查看 "View Code" 按钮
   ```

3. **适配到项目**：
   ```typescript
   // 复制核心样式
   .employee-card {
     @apply transition-all duration-300;
     @apply hover:scale-105 hover:shadow-2xl;
     @apply hover:ring-2 hover:ring-primary/20;
   }
   ```

4. **测试可访问性**：
   ```typescript
   // 添加减少动效支持
   @media (prefers-reduced-motion: reduce) {
     .employee-card {
       transition: none;
     }
   }
   ```

---

### 案例 2：实现工具审批对话框

**需求**：安全的工具调用确认对话框

**步骤**：

1. **找基础组件**：
   ```bash
   # 安装 shadcn/ui Alert Dialog
   npx shadcn-ui@latest add alert-dialog
   ```

2. **参考安全提示设计**：
   ```
   → GitHub Danger Zone (primer.style)
   → Stripe Confirmation Dialog
   → Vercel Danger Modal
   ```

3. **实现要点**：
   - 警告色（橙色/红色）
   - 倒计时自动拒绝
   - 拒绝按钮默认焦点
   - 风险提示框
   - 参数预览（代码块）

4. **已实现代码位置**：
   ```
   src/components/ToolApprovalDialog.tsx
   ```

---

### 案例 3：优化对话界面

**需求**：流畅的 AI 对话体验

**步骤**：

1. **参考最佳实践**：
   ```
   → Vercel AI SDK UI Examples
   → https://sdk.vercel.ai/examples
   → 查看 "Chatbot" 示例
   ```

2. **借鉴开源项目**：
   ```
   → Lobe Chat
   → https://github.com/lobehub/lobe-chat
   → src/app/chat/features/Conversation
   ```

3. **关键功能**：
   - 流式输出（逐字显示）
   - 自动滚动到底部
   - "回到底部"浮动按钮
   - 工具调用状态显示
   - 消息气泡动画

4. **性能优化**：
   ```typescript
   // 使用 React.memo 避免重渲染
   const MessageBubble = React.memo(({ message }) => {
     // ...
   })
   
   // 虚拟滚动长对话
   import { useVirtualizer } from '@tanstack/react-virtual'
   ```

---

## 🚀 快速启动清单

### 新建组件时的标准流程

```
✅ 1. 确定组件类型（卡片/表单/模态框/列表）
✅ 2. 在本文档找到对应参考网站
✅ 3. 浏览 2-3 个参考设计
✅ 4. 从 shadcn/ui 安装基础组件（如果有）
✅ 5. 复制参考代码并适配到项目技术栈
✅ 6. 测试响应式布局（1200x800 和 960x640）
✅ 7. 检查可访问性（键盘、屏幕阅读器、颜色对比）
✅ 8. 添加减少动效支持
✅ 9. 在实际场景中测试
✅ 10. 记录参考来源（代码注释或本文档）
```

### shadcn/ui 组件安装速查

```bash
# 最常用的基础组件
npx shadcn-ui@latest add button
npx shadcn-ui@latest add input
npx shadcn-ui@latest add card
npx shadcn-ui@latest add dialog
npx shadcn-ui@latest add sheet
npx shadcn-ui@latest add dropdown-menu
npx shadcn-ui@latest add select
npx shadcn-ui@latest add textarea
npx shadcn-ui@latest add alert-dialog
npx shadcn-ui@latest add skeleton
npx shadcn-ui@latest add toast

# 查看所有可用组件
npx shadcn-ui@latest add
```

---

## 🔗 书签收藏建议

**必备书签（按使用频率排序）**：

1. **shadcn/ui** - https://ui.shadcn.com/
2. **Lucide Icons** - https://lucide.dev/
3. **Tailwind CSS Docs** - https://tailwindcss.com/docs
4. **Radix UI Themes** - https://www.radix-ui.com/themes
5. **TanStack Docs** - https://tanstack.com/
6. **Framer Motion** - https://www.framer.com/motion/
7. **BeautifulUI** - https://beautifului.dev/
8. **Aceternity UI** - https://ui.aceternity.com/
9. **Flowbite** - https://flowbite.com/
10. **React Aria** - https://react-spectrum.adobe.com/react-aria/

**灵感收集**：

- **Dribbble** - https://dribbble.com/tags/desktop-app
- **Behance** - https://www.behance.net/search/projects?search=desktop%20application
- **Mobbin** - https://mobbin.com/browse/mac/apps
- **Awwwards** - https://www.awwwards.com/websites/app-design/

---

## 💡 Pro Tips

### 1. 先看 shadcn/ui，再看其他
shadcn/ui 基于 Radix + Tailwind，代码可以直接复制到项目，无需安装额外依赖。

### 2. 参考 Electron 应用，而非网页应用
VS Code、Figma、Discord 的设计更适合桌面环境，Notion、Linear 的设计更适合浏览器。

### 3. 借鉴设计，不要照搬代码
开源项目的代码质量参差不齐，学习设计思路和交互模式，用项目的技术栈重新实现。

### 4. 优先考虑可访问性
Radix UI 的所有组件都内置可访问性支持，从它开始可以省去很多 ARIA 属性的处理。

### 5. 减少动效是必选项，不是可选项
```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

### 6. 测试真实数据
- 空状态（0 条记录）
- 少量数据（1-3 条）
- 正常数据（10-50 条）
- 大量数据（100+ 条）
- 超长文本（员工名称 20+ 字符）

### 7. 桌面优先，而非移动优先
这是 Electron 应用，用户都是坐在电脑前，不需要考虑触摸手势和小屏幕。

### 8. 保持设计一致性
建立组件库文档（Storybook 或 Ladle），确保所有页面使用相同的按钮、输入框、卡片样式。

---

## 📚 延伸阅读

**设计原则**：
- [Refactoring UI](https://www.refactoringui.com/) - Tailwind 作者的设计书
- [Laws of UX](https://lawsofux.com/) - UX 设计原则
- [Inclusive Components](https://inclusive-components.design/) - 可访问性组件模式

**技术文档**：
- [Radix UI Docs](https://www.radix-ui.com/primitives/docs/overview/introduction)
- [Tailwind CSS Best Practices](https://tailwindcss.com/docs/reusing-styles)
- [React Performance](https://react.dev/learn/render-and-commit)

**Electron 开发**：
- [Electron Best Practices](https://www.electronjs.org/docs/latest/tutorial/security)
- [VS Code Extension Guide](https://code.visualstudio.com/api/ux-guidelines/overview)

---

**最后更新**: 2026-09-21
**维护者**: 项目组
**反馈**: 发现更好的参考资源？在团队会议中分享或更新本文档
