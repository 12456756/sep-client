# 方案 B：视觉叙事风 - 情感体验型

> **设计理念**：用视觉讲故事，让工具有温度。适合注重体验和品牌形象的企业，强调情感连接和使用愉悦感。

---

## 🎯 设计定位

**目标用户**：注重体验的企业、创意团队、品牌形象敏感的公司、偶尔使用的用户

**核心价值**：
- ✅ 视觉吸引力强，首次使用就留下深刻印象
- ✅ 情感化设计，让 AI 员工更"真实"
- ✅ 品牌识别度高，差异化明显
- ✅ 使用愉悦感，提升用户满意度

**设计风格**：Loom、Figma、Notion、Raycast、Arc Browser

---

## 🎨 视觉系统

### 配色方案（暖色系 + 高对比）

```css
/* 保持并强化现有的暖陶土主色 */
--brand-primary: #c4612f;      /* 暖陶土 */
--brand-hover: #a94e22;        /* 深陶土 */
--brand-soft: #f5e6da;         /* 浅陶底 */
--brand-glow: rgba(196, 97, 47, 0.15); /* 辉光效果 */

/* 第二主色：暖金（用于强调和点缀） */
--accent-gold: #d4a574;
--accent-gold-soft: #f7ebe1;

/* 背景层次（温暖的奶油色系）*/
--bg-cream: #faf8f5;           /* 页面底色 */
--bg-warm: #f7f4ef;            /* 现有主背景 */
--bg-card: #ffffff;            /* 卡片 */
--bg-subtle: #fbf9f6;          /* 次级背景 */

/* 文字（保持暖调）*/
--text-dark: #2d2520;          /* 主文字 */
--text-body: #4a4139;          /* 正文 */
--text-secondary: #6b625a;     /* 次要文字 */
--text-tertiary: #948a82;      /* 辅助文字 */

/* 边框（柔和的暖灰）*/
--border-soft: #f0ebe3;
--border-default: #e7e0d6;
--border-strong: #d8cfc2;

/* 渐变（用于大背景和装饰）*/
--gradient-hero: linear-gradient(135deg, #faf8f5 0%, #f5e9dd 100%);
--gradient-card: linear-gradient(180deg, #ffffff 0%, #fdfbf9 100%);
--gradient-accent: linear-gradient(135deg, #d4a574 0%, #c4612f 100%);
```

### 字体系统（混合字体）

```css
/* 标题：衬线字体（增强品牌感）*/
--font-display: 'Fraunces', 'Playfair Display', 'DM Serif Display', serif;

/* 正文：现有 Inter */
--font-body: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;

/* 等宽：代码和数据 */
--font-mono: 'JetBrains Mono', 'Fira Code', monospace;

/* 字号阶梯（更大的对比）*/
--text-xs: 11px;
--text-sm: 13px;
--text-base: 15px;    /* 比方案 A 大 1px */
--text-lg: 18px;
--text-xl: 24px;      /* 大标题 */
--text-2xl: 32px;     /* Hero 标题 */
--text-3xl: 40px;     /* 超大标题 */

/* 行高（更宽松）*/
--leading-tight: 1.25;
--leading-normal: 1.6;
--leading-relaxed: 1.8;
```

### 间距系统（宽松）

```css
/* 8px 基础单位（比方案 A 的 4px 更宽松）*/
--space-1: 8px;
--space-2: 16px;
--space-3: 24px;
--space-4: 32px;
--space-6: 48px;
--space-8: 64px;
--space-12: 96px;

/* 卡片内边距 */
--card-padding-sm: 20px;
--card-padding: 24px;   /* 现有设计 */
--card-padding-lg: 32px;
```

### 圆角（大圆角 + 不规则形状）

```css
--radius-sm: 8px;
--radius-md: 12px;     /* 卡片 */
--radius-lg: 16px;     /* 大卡片 */
--radius-xl: 24px;     /* 特大容器 */
--radius-full: 9999px; /* 完全圆形 */

/* 不规则圆角（独特设计）*/
--radius-organic: 8px 16px 12px 20px; /* 左上 右上 右下 左下 */
```

### 阴影（层次分明）

```css
/* 三层阴影系统 */
--shadow-sm: 0 1px 3px rgba(45, 37, 32, 0.08);
--shadow-md: 
  0 4px 8px rgba(45, 37, 32, 0.06),
  0 2px 4px rgba(45, 37, 32, 0.04);
--shadow-lg: 
  0 12px 24px rgba(45, 37, 32, 0.08),
  0 4px 8px rgba(45, 37, 32, 0.04);
--shadow-xl: 
  0 24px 48px rgba(45, 37, 32, 0.12),
  0 8px 16px rgba(45, 37, 32, 0.06);

/* 彩色阴影（用于主按钮和强调元素）*/
--shadow-accent: 0 8px 24px rgba(196, 97, 47, 0.2);
--shadow-glow: 0 0 40px rgba(196, 97, 47, 0.15);
```

---

## 📐 布局结构

### 整体布局（流动式）

```
┌─────────────────────────────────────────────┐
│ [Hero Banner - 渐变背景 120px]               │
├──────┬──────────────────────────────────────┤
│      │                                      │
│ Side │                                      │
│ Nav  │        Main Content                  │
│ 240px│        (带圆角壳和阴影)               │
│      │                                      │
│ 浮动  │                                      │
│ 卡片  │                                      │
└──────┴──────────────────────────────────────┘

/* 特点：
  - 侧边栏浮动在背景上（白色卡片 + 阴影）
  - 主内容区也是浮动卡片
  - 整体有呼吸感
*/
```

### Hero Banner（品牌展示区）

```typescript
<div className="hero-banner">
  <div className="hero-gradient" /> {/* 渐变背景 */}
  <div className="hero-content">
    <h1 className="hero-title">
      <span className="text-gradient">硅基工作台</span>
    </h1>
    <p className="hero-subtitle">
      让 AI 员工为你工作
    </p>
  </div>
  <div className="hero-decoration">
    {/* 装饰性几何图形 */}
    <div className="floating-circle" />
    <div className="floating-blob" />
  </div>
</div>
```

### SideNav（视觉化导航）

```typescript
<nav className="side-nav-floating">
  {/* Logo 区 */}
  <div className="side-nav-header">
    <div className="logo-container">
      <div className="logo-icon">🤖</div>
      <div className="logo-text">SEP</div>
    </div>
  </div>

  {/* 导航项：大图标 + 文字 */}
  <div className="nav-items">
    <NavItem icon={<Home />} label="工作台" active />
    <NavItem icon={<Users />} label="员工" />
    <NavItem icon={<Briefcase />} label="任务" />
    <NavItem icon={<Settings />} label="设置" />
  </div>

  {/* 快速操作：悬浮按钮 */}
  <div className="nav-fab">
    <button className="fab-button">
      <Plus size={20} />
    </button>
    <span className="fab-label">新建对话</span>
  </div>

  {/* 用户信息 */}
  <div className="nav-user">
    <Avatar size="md" />
    <div className="user-info">
      <strong>张三</strong>
      <span>在线</span>
    </div>
  </div>
</nav>
```

**样式特点**：
```css
.side-nav-floating {
  background: white;
  border-radius: 16px;
  box-shadow: var(--shadow-lg);
  margin: 16px;
  padding: 20px;
  position: fixed;
  left: 0;
  top: 120px; /* Hero banner 高度 */
  width: 240px;
  height: calc(100vh - 136px);
}

.nav-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 导航项：大图标 + 动画 */
.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 10px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.nav-item:hover {
  background: var(--brand-soft);
  transform: translateX(4px);
}

.nav-item.active {
  background: var(--brand-primary);
  color: white;
  box-shadow: var(--shadow-accent);
}
```

---

## 🏠 核心页面重设计

### 1. 首页（HomePage）- 情感化仪表盘

#### 设计理念
将首页打造成"团队工作室"，每个员工是一个独立的"工位"

#### 布局方案

```typescript
<div className="home-page-narrative">
  {/* Hero 区：欢迎和概览 */}
  <section className="home-hero">
    <div className="hero-text">
      <span className="eyebrow">早上好，张三 👋</span>
      <h1 className="display-title">
        你的硅基团队<em>正在待命</em>
      </h1>
      <p className="hero-description">
        {usable} 位员工可以立即开始工作，{busy} 位正在忙碌中
      </p>
    </div>
    
    {/* 快速开始按钮 */}
    <button className="btn-hero-primary">
      <Sparkles size={20} />
      快速派活
    </button>
  </section>

  {/* 统计卡片：大数字 + 可视化 */}
  <section className="stats-showcase">
    <StatCardShowcase
      value={overview.totalEmployees}
      label="公司员工"
      icon={<Building2 />}
      gradient="from-blue-400 to-blue-600"
    />
    <StatCardShowcase
      value={roster.length}
      label="我的员工"
      icon={<Users />}
      gradient="from-orange-400 to-orange-600"
    />
    <StatCardShowcase
      value={todayCompleted}
      label="今日完成"
      icon={<CheckCircle2 />}
      gradient="from-green-400 to-green-600"
      trend="+12%"
    />
    <StatCardShowcase
      value={inProgress}
      label="进行中"
      icon={<Clock />}
      gradient="from-purple-400 to-purple-600"
    />
  </section>

  {/* 员工"工位"墙 */}
  <section className="employee-studio">
    <div className="section-header">
      <h2 className="section-title">我的员工工位</h2>
      <button className="btn-ghost">查看全部 →</button>
    </div>
    
    {/* 大卡片，丰富信息 */}
    <div className="employee-grid-showcase">
      {roster.map(employee => (
        <EmployeeCardShowcase
          key={employee.id}
          employee={employee}
          works={getEmployeeWorks(employee.id)}
        />
      ))}
    </div>
  </section>

  {/* 最近活动流 */}
  <section className="activity-timeline">
    <h2 className="section-title">最近活动</h2>
    <ActivityTimeline activities={recentActivities} />
  </section>
</div>
```

**参考资源**：
- **Loom Dashboard**: https://www.loom.com/
- **Notion Home**: https://www.notion.so/
- **Figma Dashboard**: https://www.figma.com/
- **Raycast**: https://www.raycast.com/

---

### 2. 员工卡片（EmployeeCard）- 拟人化设计

#### 设计理念
每张卡片都像一个"名片"，展示员工的"个性"和"状态"

#### 优化方案 B：展示型卡片

```typescript
<article className="employee-card-showcase">
  {/* 顶部：渐变背景 + 状态光环 */}
  <div className="card-header-gradient">
    <div className="status-glow" data-status={availability} />
    
    {/* 大头像 + 装饰圈 */}
    <div className="avatar-showcase">
      <div className="avatar-ring" />
      <EmployeeFace size="xl" seed={employee.id} />
      <div className="status-badge">
        <StatusIcon status={availability} />
      </div>
    </div>
  </div>

  {/* 主体：员工信息 */}
  <div className="card-body">
    <h3 className="employee-name">{name}</h3>
    <p className="employee-role">{intro}</p>

    {/* 擅长领域：彩色标签 */}
    <div className="skills-showcase">
      {goodAt.slice(0, 3).map((skill, i) => (
        <span 
          key={skill} 
          className="skill-tag"
          style={{ 
            background: `var(--skill-color-${i % 5})` 
          }}
        >
          <Sparkles size={12} />
          {skill}
        </span>
      ))}
    </div>

    {/* 实时状态 */}
    <div className="employee-status-bar">
      {working ? (
        <div className="status-active">
          <div className="pulse-dot" />
          <span>正在工作中...</span>
        </div>
      ) : (
        <div className="status-ready">
          <CheckCircle2 size={14} />
          <span>随时待命</span>
        </div>
      )}
    </div>

    {/* 今日工作进度 */}
    <div className="work-progress">
      <div className="progress-label">
        <span>今日完成</span>
        <strong>{load.done}/{load.total}</strong>
      </div>
      <div className="progress-bar">
        <div 
          className="progress-fill"
          style={{ width: `${(load.done / load.total) * 100}%` }}
        />
      </div>
    </div>

    {/* 操作按钮 */}
    <div className="card-actions">
      <button className="btn-card-primary" onClick={() => onChat?.(id)}>
        <MessageSquare size={16} />
        开始对话
      </button>
      <button className="btn-card-ghost" onClick={() => onOpen(id)}>
        <Info size={16} />
      </button>
    </div>
  </div>

  {/* 底部：微妙的装饰 */}
  <div className="card-decoration">
    <div className="deco-line" />
  </div>
</article>
```

**样式特点**：
```css
.employee-card-showcase {
  background: var(--gradient-card);
  border-radius: 16px;
  box-shadow: var(--shadow-md);
  overflow: hidden;
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  height: 380px; /* 比方案 A 高很多，展示更多信息 */
}

.employee-card-showcase:hover {
  transform: translateY(-8px);
  box-shadow: var(--shadow-xl);
}

/* 顶部渐变背景 */
.card-header-gradient {
  height: 140px;
  background: var(--gradient-accent);
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 状态光环效果 */
.status-glow {
  position: absolute;
  inset: 0;
  opacity: 0.3;
  background: radial-gradient(
    circle at center,
    var(--glow-color) 0%,
    transparent 70%
  );
}

.status-glow[data-status="working"] {
  --glow-color: var(--brand-primary);
  animation: pulse 2s ease-in-out infinite;
}

/* 头像容器 */
.avatar-showcase {
  width: 96px;
  height: 96px;
  position: relative;
  z-index: 2;
}

.avatar-ring {
  position: absolute;
  inset: -6px;
  border: 3px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  animation: rotate 20s linear infinite;
}

/* 状态徽章 */
.status-badge {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 28px;
  height: 28px;
  background: white;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

/* 卡片主体 */
.card-body {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.employee-name {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-dark);
  margin: 0;
}

.employee-role {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
  margin: 0;
}

/* 技能标签：彩色背景 */
.skills-showcase {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.skill-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  color: white;
  backdrop-filter: blur(4px);
}

/* 5 种彩色方案 */
:root {
  --skill-color-0: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  --skill-color-1: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
  --skill-color-2: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
  --skill-color-3: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);
  --skill-color-4: linear-gradient(135deg, #fa709a 0%, #fee140 100%);
}

/* 进度条 */
.progress-bar {
  height: 6px;
  background: var(--bg-subtle);
  border-radius: 999px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--brand-primary);
  border-radius: 999px;
  transition: width 0.6s ease-out;
}

/* 脉动动画 */
@keyframes pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 0.6; }
}

@keyframes rotate {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
```

**参考资源**：
- **Aceternity UI Hover Cards**: https://ui.aceternity.com/components/hover-effect
- **Magic UI Bento Grid**: https://magicui.design/docs/components/bento-grid
- **BeautifulUI Profile Cards**: https://beautifului.dev/

---

### 3. 统计卡片（StatCard）- 数据可视化

```typescript
<div className="stat-card-showcase">
  {/* 图标背景 */}
  <div className="stat-icon-bg" style={{ background: gradient }}>
    {icon}
  </div>

  {/* 数值 */}
  <div className="stat-content">
    <div className="stat-value-wrapper">
      <span className="stat-value">{value}</span>
      {trend && (
        <span className="stat-trend positive">
          <TrendingUp size={14} />
          {trend}
        </span>
      )}
    </div>
    <p className="stat-label">{label}</p>
  </div>

  {/* 装饰性图表 */}
  <div className="stat-chart">
    <MiniSparkline data={historicalData} />
  </div>
</div>
```

**样式**：
```css
.stat-card-showcase {
  background: white;
  border-radius: 16px;
  padding: 24px;
  box-shadow: var(--shadow-md);
  position: relative;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.3s ease;
}

.stat-card-showcase:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-lg);
}

.stat-icon-bg {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  margin-bottom: 16px;
}

.stat-value {
  font-size: 36px;
  font-weight: 700;
  color: var(--text-dark);
  line-height: 1;
}

.stat-label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 4px;
}

/* 迷你图表 */
.stat-chart {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 120px;
  height: 40px;
  opacity: 0.2;
}
```

---

### 4. 对话界面（ConversationView）- 沉浸式对话

#### 设计理念
打造"面对面"的对话感，而不是冷冰冰的聊天记录

```typescript
<div className="conversation-immersive">
  {/* 顶部：大头像 + 员工信息 */}
  <header className="conversation-hero">
    <div className="employee-avatar-large">
      <div className="avatar-glow" />
      <EmployeeFace size="2xl" seed={employee.id} />
      <div className="status-indicator" data-status={employee.availability} />
    </div>
    
    <div className="employee-meta">
      <h2 className="employee-name">{employee.name}</h2>
      <p className="employee-status-text">
        {employee.availability === 'working' ? (
          <>
            <span className="pulse-dot" />
            正在为你工作...
          </>
        ) : (
          '随时待命'
        )}
      </p>
    </div>

    <div className="conversation-actions">
      <button className="btn-icon-lg" onClick={onStop}>
        <PauseCircle size={20} />
      </button>
      <button className="btn-icon-lg">
        <MoreVertical size={20} />
      </button>
    </div>
  </header>

  {/* 消息流：大气泡 + 丰富排版 */}
  <div className="messages-flow" ref={scrollRef}>
    {messages.map(msg => (
      <div key={msg.id} className={`message-bubble-${msg.role}`}>
        {msg.role === 'assistant' && (
          <div className="message-avatar-inline">
            <EmployeeFace size="sm" seed={employee.id} />
          </div>
        )}
        
        <div className="message-content-rich">
          {/* 消息元信息 */}
          <div className="message-meta">
            <span className="sender-name">
              {msg.role === 'user' ? '我' : employee.name}
            </span>
            <span className="message-time">
              {formatTime(msg.timestamp)}
            </span>
          </div>

          {/* 消息正文 */}
          <div className="message-text-rich">
            {msg.content}
          </div>

          {/* 消息附件（如果有）*/}
          {msg.attachments && (
            <div className="message-attachments">
              {msg.attachments.map(att => (
                <AttachmentCard key={att.id} {...att} />
              ))}
            </div>
          )}
        </div>
      </div>
    ))}

    {/* 工具调用：更可视化 */}
    {activity && (
      <div className="tool-call-showcase">
        <div className="tool-icon-animated">
          <Wrench size={24} />
        </div>
        <div className="tool-info">
          <strong>正在使用工具</strong>
          <p>{activity}</p>
        </div>
        <div className="tool-spinner">
          <Loader2 className="animate-spin" size={20} />
        </div>
      </div>
    )}
  </div>

  {/* 输入区：丰富功能 */}
  <div className="conversation-composer">
    <div className="composer-toolbar">
      <button className="btn-icon" title="添加附件">
        <Paperclip size={18} />
      </button>
      <button className="btn-icon" title="插入表情">
        <Smile size={18} />
      </button>
      <button className="btn-icon" title="语音输入">
        <Mic size={18} />
      </button>
    </div>
    
    <div className="composer-input-area">
      <Textarea
        placeholder="告诉我你想做什么..."
        className="composer-textarea"
        rows={3}
      />
      
      <button className="btn-send-primary">
        <Send size={18} />
        <span>发送</span>
      </button>
    </div>
  </div>
</div>
```

**样式特点**：
```css
.conversation-immersive {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-cream);
}

/* 顶部 Hero */
.conversation-hero {
  padding: 32px;
  background: white;
  border-bottom: 1px solid var(--border-soft);
  display: flex;
  align-items: center;
  gap: 20px;
}

.employee-avatar-large {
  position: relative;
  width: 80px;
  height: 80px;
}

.avatar-glow {
  position: absolute;
  inset: -12px;
  background: var(--brand-glow);
  border-radius: 50%;
  filter: blur(16px);
  animation: pulse 3s ease-in-out infinite;
}

/* 消息流 */
.messages-flow {
  flex: 1;
  overflow-y: auto;
  padding: 32px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* AI 消息：左侧，浅色背景 */
.message-bubble-assistant {
  display: flex;
  gap: 12px;
  max-width: 80%;
  align-self: flex-start;
}

.message-content-rich {
  background: white;
  border-radius: 16px 16px 16px 4px;
  padding: 16px 20px;
  box-shadow: var(--shadow-sm);
}

/* 用户消息：右侧，品牌色背景 */
.message-bubble-user {
  max-width: 80%;
  align-self: flex-end;
}

.message-bubble-user .message-content-rich {
  background: var(--brand-primary);
  color: white;
  border-radius: 16px 16px 4px 16px;
  box-shadow: var(--shadow-accent);
}

/* 消息文本：大字号，宽松行高 */
.message-text-rich {
  font-size: 15px;
  line-height: 1.6;
  color: var(--text-body);
}

.message-bubble-user .message-text-rich {
  color: white;
}

/* 工具调用卡片 */
.tool-call-showcase {
  background: var(--gradient-card);
  border: 2px dashed var(--border-default);
  border-radius: 12px;
  padding: 20px;
  display: flex;
  align-items: center;
  gap: 16px;
  align-self: center;
  max-width: 400px;
}

.tool-icon-animated {
  width: 48px;
  height: 48px;
  background: var(--brand-soft);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--brand-primary);
  animation: bounce 1s ease-in-out infinite;
}

@keyframes bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}

/* 输入区 */
.conversation-composer {
  background: white;
  border-top: 1px solid var(--border-soft);
  padding: 20px 32px;
}

.composer-input-area {
  display: flex;
  gap: 12px;
  align-items: flex-end;
}

.composer-textarea {
  flex: 1;
  border: 2px solid var(--border-default);
  border-radius: 12px;
  padding: 12px 16px;
  font-size: 15px;
  line-height: 1.5;
  resize: none;
  transition: all 0.2s ease;
}

.composer-textarea:focus {
  border-color: var(--brand-primary);
  box-shadow: 0 0 0 4px var(--brand-glow);
  outline: none;
}

.btn-send-primary {
  background: var(--gradient-accent);
  color: white;
  border: none;
  border-radius: 12px;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: var(--shadow-accent);
}

.btn-send-primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 32px rgba(196, 97, 47, 0.3);
}
```

**参考资源**：
- **Loom Messaging**: https://www.loom.com/
- **Linear Comments**: https://linear.app/
- **Notion Comments**: https://www.notion.so/

---

### 5. 工具审批对话框 - 戏剧化设计

```typescript
<Dialog className="tool-approval-dramatic">
  <div className="dialog-backdrop-blur" />
  
  <DialogContent className="dialog-content-large">
    {/* 顶部：警告视觉 */}
    <div className="alert-header">
      <div className="alert-icon-large">
        <ShieldAlert size={48} />
      </div>
      <h2 className="alert-title">工具执行授权</h2>
      <p className="alert-subtitle">
        AI 请求在您的系统上执行操作
      </p>
    </div>

    {/* 倒计时：大数字 */}
    <div className="countdown-showcase">
      <div className="countdown-ring">
        <svg className="countdown-svg">
          <circle className="countdown-track" />
          <circle 
            className="countdown-progress" 
            style={{ 
              strokeDashoffset: `${(1 - countdown / 60) * 283}` 
            }}
          />
        </svg>
        <div className="countdown-text">
          <span className="countdown-value">{countdown}</span>
          <span className="countdown-label">秒</span>
        </div>
      </div>
      <p className="countdown-hint">超时自动拒绝</p>
    </div>

    {/* 工具信息：卡片展示 */}
    <div className="tool-info-card">
      <div className="tool-detail">
        <label>工具名称</label>
        <code className="tool-name">{toolName}</code>
      </div>
      
      <div className="tool-detail">
        <label>风险等级</label>
        <div className="risk-badge high">
          <AlertTriangle size={14} />
          高风险
        </div>
      </div>

      <div className="tool-detail full">
        <label>参数内容</label>
        <pre className="tool-params">{formatInput(input)}</pre>
      </div>

      <div className="tool-warning">
        <AlertCircle size={16} />
        <p>{riskDescription}</p>
      </div>
    </div>

    {/* 底部：大按钮 */}
    <div className="dialog-actions-large">
      <button 
        className="btn-deny-large"
        onClick={onDeny}
      >
        <X size={20} />
        拒绝执行
      </button>
      <button 
        className="btn-approve-large"
        onClick={onApprove}
      >
        <Check size={20} />
        允许执行
      </button>
    </div>
  </DialogContent>
</Dialog>
```

**样式**：
```css
.dialog-backdrop-blur {
  backdrop-filter: blur(8px);
  background: rgba(45, 37, 32, 0.4);
}

.dialog-content-large {
  max-width: 600px;
  border-radius: 24px;
  padding: 40px;
  background: white;
  box-shadow: var(--shadow-xl);
}

/* 倒计时环 */
.countdown-ring {
  width: 160px;
  height: 160px;
  position: relative;
  margin: 0 auto 16px;
}

.countdown-svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

.countdown-track {
  cx: 80;
  cy: 80;
  r: 45;
  fill: none;
  stroke: var(--border-soft);
  stroke-width: 8;
}

.countdown-progress {
  cx: 80;
  cy: 80;
  r: 45;
  fill: none;
  stroke: var(--warning);
  stroke-width: 8;
  stroke-linecap: round;
  stroke-dasharray: 283;
  transition: stroke-dashoffset 1s linear;
}

.countdown-text {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.countdown-value {
  font-size: 48px;
  font-weight: 700;
  color: var(--warning);
  line-height: 1;
}

/* 大按钮 */
.btn-deny-large,
.btn-approve-large {
  flex: 1;
  height: 56px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  transition: all 0.3s ease;
}

.btn-deny-large {
  background: var(--bg-subtle);
  color: var(--text-body);
  border: 2px solid var(--border-default);
}

.btn-deny-large:hover {
  background: var(--danger);
  color: white;
  border-color: var(--danger);
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.btn-approve-large {
  background: var(--gradient-accent);
  color: white;
  border: none;
  box-shadow: var(--shadow-accent);
}

.btn-approve-large:hover {
  transform: translateY(-2px);
  box-shadow: 0 16px 40px rgba(196, 97, 47, 0.3);
}
```

---

## 🎨 动画和微交互

### 1. 页面过渡

```typescript
// 使用 Framer Motion
import { motion } from 'framer-motion'

<motion.div
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  exit={{ opacity: 0, y: -20 }}
  transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
>
  {children}
</motion.div>
```

### 2. 卡片悬停

```css
.card-interactive {
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.card-interactive:hover {
  transform: translateY(-8px) scale(1.02);
  box-shadow: var(--shadow-xl);
}

.card-interactive:hover .card-glow {
  opacity: 1;
}
```

### 3. 加载状态

```typescript
<div className="loading-showcase">
  <div className="loading-dots">
    <span className="dot" style={{ '--delay': '0s' }} />
    <span className="dot" style={{ '--delay': '0.2s' }} />
    <span className="dot" style={{ '--delay': '0.4s' }} />
  </div>
  <p>正在处理...</p>
</div>
```

```css
@keyframes bounce-dot {
  0%, 80%, 100% { transform: scale(1); }
  40% { transform: scale(1.3); }
}

.dot {
  width: 8px;
  height: 8px;
  background: var(--brand-primary);
  border-radius: 50%;
  animation: bounce-dot 1.4s infinite ease-in-out;
  animation-delay: var(--delay);
}
```

---

## 🧩 组件库和工具

### 推荐组件库

```bash
# 1. Aceternity UI（科技感组件）
# 访问 https://ui.aceternity.com/
# 复制代码到项目

# 2. Magic UI（炫酷效果）
# 访问 https://magicui.design/
# npm install magic-ui（如果需要）

# 3. Framer Motion（动画）⭐️
npm install framer-motion

# 4. Embla Carousel（轮播）
npm install embla-carousel-react

# 5. Recharts（数据可视化）
npm install recharts
```

### 图标和插图

```bash
# Lucide Icons（已有）
# https://lucide.dev/

# 免费插图库
# Undraw: https://undraw.co/
# Humaaans: https://www.humaaans.com/
# Open Doodles: https://www.opendoodles.com/
```

---

## 📊 实施优先级

### P0 - 视觉基础（2-3 天）

1. ✅ **配色系统升级**
   - 保持暖陶土主色
   - 添加渐变和辉光效果
   - 定义 5 种彩色标签方案

2. ✅ **安装 Framer Motion**
   ```bash
   npm install framer-motion
   ```

3. ✅ **Hero Banner 实现**
   - 渐变背景
   - 装饰性几何图形
   - 欢迎文案

### P1 - 核心组件（5-7 天）

4. ✅ **员工卡片 Showcase 版**
   - 渐变顶部
   - 大头像 + 光环
   - 彩色技能标签
   - 进度条

5. ✅ **统计卡片可视化**
   - 图标背景渐变
   - 迷你图表
   - 趋势指示器

6. ✅ **对话界面升级**
   - 沉浸式顶部
   - 大气泡消息
   - 丰富输入区

### P2 - 高级功能（7-10 天）

7. ✅ **活动时间轴**
   ```bash
   npm install react-vertical-timeline-component
   ```

8. ✅ **数据可视化**
   ```bash
   npm install recharts
   ```

9. ✅ **微交互动画**
   - 悬停效果
   - 加载动画
   - 页面过渡

---

## 🎯 两套方案对比

| 维度 | 方案 A：极简商务风 | 方案 B：视觉叙事风 |
|-----|------------------|------------------|
| **设计风格** | Linear、GitHub、Notion | Loom、Figma、Raycast |
| **配色** | 中性灰 + 蓝色强调 | 暖色系 + 彩色渐变 |
| **间距** | 紧凑（4px 基础） | 宽松（8px 基础） |
| **圆角** | 最小化（4-8px） | 大圆角（12-24px） |
| **阴影** | 极简 | 层次分明 |
| **字体** | 单一 Inter | 混合（衬线 + 无衬线） |
| **员工卡片高度** | 140px | 380px |
| **首屏可见员工** | 12 张 | 6 张 |
| **动画** | <200ms，最小化 | 300-400ms，丰富 |
| **信息密度** | 高 | 中等 |
| **视觉吸引力** | 低 | 高 |
| **学习曲线** | 平缓 | 陡峭 |
| **适用场景** | 高频使用、效率优先 | 品牌展示、体验优先 |
| **开发周期** | 7-10 天 | 10-14 天 |
| **性能** | 优秀 | 良好 |
| **CLI 工具** | shadcn/ui | Framer Motion + Aceternity UI |

---

## 💡 回答你的问题：CLI 工具

### 哪些可以通过 CLI 安装？

#### ✅ 可以 CLI 安装的（npm 包）

```bash
# 1. Framer Motion（动画库）
npm install framer-motion
# 然后：import { motion } from 'framer-motion'

# 2. Embla Carousel（轮播）
npm install embla-carousel-react
# 然后：import useEmblaCarousel from 'embla-carousel-react'

# 3. Recharts（图表）
npm install recharts
# 然后：import { LineChart, BarChart } from 'recharts'

# 4. React Spring（动画）
npm install @react-spring/web
# 然后：import { useSpring } from '@react-spring/web'

# 5. Auto Animate（自动动画）
npm install @formkit/auto-animate
# 然后：import { useAutoAnimate } from '@formkit/auto-animate/react'

# 6. Mantine（组件库）
npm install @mantine/core @mantine/hooks
# 然后：import { Button } from '@mantine/core'

# 7. Chakra UI（组件库）
npm install @chakra-ui/react @emotion/react
# 然后：import { Button } from '@chakra-ui/react'
```

#### ✅ shadcn/ui 特殊 CLI（不是 npm 包）

```bash
# shadcn/ui 是代码生成器，不是 npm 包
npx shadcn-ui@latest init  # 初始化
npx shadcn-ui@latest add button  # 添加组件

# 它会把代码复制到 src/components/ui/
# 优点：完全可控，不增加依赖
# 缺点：需要手动更新
```

#### ❌ 不能 CLI 安装的（只能复制代码）

```bash
# 1. Aceternity UI
# 访问 https://ui.aceternity.com/
# 点击 "View Code"，复制到项目
# 原因：没有发布 npm 包

# 2. Magic UI
# 访问 https://magicui.design/
# 复制代码到项目
# 原因：没有发布 npm 包

# 3. BeautifulUI
# 访问 https://beautifului.dev/
# 复制代码
# 原因：设计灵感网站，不是组件库

# 4. Flowbite
# 有 npm 包：npm install flowbite
# 但主要是 Tailwind 插件，组件需要复制 HTML
```

### CLI vs 复制代码，哪个更好？

| 方式 | 优点 | 缺点 | 推荐场景 |
|-----|------|------|---------|
| **npm 安装** | 自动更新、类型完整 | 黑盒、体积大 | 成熟库（Framer Motion） |
| **shadcn/ui** | 代码可控、按需添加 | 手动更新 | 基础组件（Button, Dialog） |
| **复制代码** | 完全自由、无依赖 | 无更新、需维护 | 炫酷效果（Aceternity UI） |

### 推荐策略

```bash
# 方案 A（极简商务风）
npx shadcn-ui@latest add button input card table dialog sheet
# 全部用 shadcn/ui，简单可靠

# 方案 B（视觉叙事风）
npm install framer-motion embla-carousel-react recharts
# 动画和图表用 npm 包

# 然后从 Aceternity UI / Magic UI 复制炫酷组件
# 复制 3-5 个核心效果即可（卡片悬停、渐变背景等）
```

---

## 📚 总结

### 方案 B 核心特点

✅ **视觉冲击力强**：大圆角、渐变、阴影、动画  
✅ **情感化设计**：拟人化员工卡片、沉浸式对话  
✅ **品牌差异化**：独特的暖色系 + 衬线字体  
✅ **使用愉悦感**：丰富的微交互和动画  
✅ **信息展示丰富**：大卡片展示更多细节  

### 适用场景

✅ 注重品牌形象的企业  
✅ 创意/设计团队  
✅ 偶尔使用的用户（首次印象重要）  
✅ 需要演示/展示的场景  
✅ 屏幕较大（>= 1440px）  

### 不适用场景

❌ 高频密集使用（信息密度低）  
❌ 追求极致效率（动画耗时）  
❌ 性能敏感场景（动画消耗资源）  
❌ 小屏设备（大卡片不适配）  

---

**最后更新**: 2026-09-21  
**预计工期**: 10-14 天（分 3 个阶段实施）  
**技术栈**: React 18 + Tailwind CSS 4 + Framer Motion + Aceternity UI
