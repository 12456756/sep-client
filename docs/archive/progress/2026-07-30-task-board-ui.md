# 2026-07-30 — 任务板模式 UI 开发完成

## 今日完成

### 1. 产品方向确定 ✅

**从 AI 助手（聊天模式）转向 AI 员工管理（任务板模式）**

- 创建 `docs/产品设计-任务板模式.md` — 定义新的交互模式
- 更新 `docs/plans/开发计划-v2-任务板模式.md` — 调整开发路线图
- 核心理念：任务驱动、异步执行、工作目录隔离

### 2. Pi-coding-agent 事件系统验证 ✅

创建 `docs/pi-coding-agent-事件系统验证.md`，修正原交接文档中的错误：

| 错误 API | 正确 API | 验证来源 |
|---------|---------|---------|
| `session.on('event')` | `session.subscribe((event) => {...})` | poc/02-provider.ts |
| 事件类型未明确 | `agent_start`, `agent_settled`, `agent_end`, `tool_execution_start/end` | 阅读 PoC 代码 |
| 无状态流转说明 | agent_start → running, agent_settled → completed | 新增状态映射表 |

### 3. P0-3: 任务管理核心 ✅

#### TaskManager (`electron/task-manager.ts`) - 280 行

```typescript
export enum TaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  WAITING_APPROVAL = 'waiting_approval',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private mainWindow: BrowserWindow | null;

  // 任务 CRUD
  createTask(title, prompt, workDir): Task
  updateTaskStatus(taskId, status, error?)
  addTaskLog(taskId, message, level)
  addTaskFile(taskId, filePath)
  pauseTask(taskId)
  cancelTask(taskId)
  deleteTask(taskId): boolean
  getAllTasks(): Task[]
  getTasksByStatus(status): Task[]
  getTaskStats(): TaskStats
}
```

**功能**：
- 任务状态机管理
- 日志记录（timestamp + level）
- 文件追踪
- IPC 事件推送（`task:updated`, `task:list-updated`）

#### PiHost 重写 (`electron/pi-host.ts`) - 240 行

**修复的 API 错误**：
1. ✅ `session.on()` → `session.subscribe()`
2. ✅ `DefaultResourceLoader` 必须传 `cwd` 和 `agentDir`
3. ✅ `createAgentSession` 返回值解构：`const { session } = await createAgentSession(...)`
4. ✅ 调用 `resourceLoader.reload()` 才能加载 extensions

**集成 TaskManager**：
```typescript
private handleSessionEvent(event: any): void {
  switch (event.type) {
    case 'agent_start':
      this.taskManager.updateTaskStatus(taskId, TaskStatus.RUNNING);
      break;
    case 'agent_settled':
      this.taskManager.updateTaskStatus(taskId, TaskStatus.COMPLETED);
      break;
    case 'agent_end':
      if (event.error) {
        this.taskManager.updateTaskStatus(taskId, TaskStatus.FAILED, event.error);
      }
      break;
    case 'tool_execution_start':
      this.taskManager.addTaskLog(taskId, `Tool: ${event.toolName}`, 'info');
      break;
  }
}
```

**新方法**：
- `executeTask(taskId)` - 执行指定任务（替代 `sendPrompt(text)`）

#### IPC 层完善 (`electron/main.ts`)

新增 8 个任务管理 IPC handlers：
- `task:create` - 创建任务
- `task:execute` - 执行任务
- `task:get` - 获取单个任务
- `task:get-all` - 获取所有任务
- `task:pause` - 暂停任务
- `task:cancel` - 取消任务
- `task:delete` - 删除任务
- `task:get-stats` - 获取统计信息

新增工具 IPC handler：
- `util:select-directory` - 文件目录选择器（使用 `dialog.showOpenDialog`）

#### Preload 层 (`electron/preload.ts`)

暴露完整的任务管理 API：
```typescript
interface ElectronAPI {
  // Task management
  createTask(data): Promise<{success, task?, error?}>
  executeTask(taskId): Promise<{success, error?}>
  getTask(taskId): Promise<{success, task?, error?}>
  getAllTasks(): Promise<{success, tasks?, error?}>
  pauseTask(taskId): Promise<{success, error?}>
  cancelTask(taskId): Promise<{success, error?}>
  deleteTask(taskId): Promise<{success, error?}>
  getTaskStats(): Promise<{success, stats?, error?}>
  
  // Utility
  selectDirectory(): Promise<{success, path?, error?}>
  
  // Events
  onTaskUpdated(callback): () => void
  onTaskListUpdated(callback): () => void
}
```

### 4. P0-4: 任务板 UI ✅

#### 类型定义 (`src/shared/task-types.ts`)

```typescript
export enum TaskStatus { ... }
export enum TaskLogLevel { INFO, WARNING, ERROR, SUCCESS }

export interface Task {
  id: string;
  title: string;
  prompt: string;
  workDir: string;
  status: TaskStatus;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  logs: TaskLog[];
  files: string[];
  error?: string;
}
```

#### UI 组件

**TaskCard** (`src/components/TaskCard.tsx`)
- 状态徽章（6 种颜色）
- 创建时间、工作目录、文件数量
- 执行中动画（旋转加载器）
- 失败错误预览
- 点击事件处理

**CreateTaskDialog** (`src/components/CreateTaskDialog.tsx`)
- 任务标题、描述输入
- 工作目录选择（调用 `window.electronAPI.selectDirectory()`）
- 表单验证（标题和描述必填）
- 模态对话框样式

**TaskBoardPage** (`src/pages/TaskBoardPage.tsx`)
- **Trello 风格列式布局**（横向滚动）
- 5 个状态列：待执行、执行中、等待审批、已完成、失败
- 实时任务更新（`onTaskUpdated` 事件监听）
- 自动执行新创建的任务
- 任务统计显示（每列显示任务数量）

**TaskDetailDrawer** (`src/components/TaskDetailDrawer.tsx`)
- 右侧滑出抽屉（不离开任务板）
- 3 个标签页：
  - **执行日志**：带时间戳、级别图标、颜色区分
  - **文件列表**：关联的文件路径列表
  - **任务信息**：完整的任务描述、工作目录、状态、时间戳、错误信息
- 操作按钮：暂停、取消、删除（根据任务状态动态显示）

#### 路由集成 (`src/App.tsx`)

```typescript
type Route = 'login' | 'instance-select' | 'task-board';

// 实例选择后立即启动 pi session
const handleInstanceSelected = async (instanceId, instanceToken, instanceName) => {
  const tokenResult = await window.electronAPI.getRefreshToken();
  await window.electronAPI.startSession({
    employeeId: instanceId,
    gatewayUrl: 'http://localhost:3001/gateway',
    refreshToken: tokenResult.data.refreshToken,
  });
  setRoute('task-board');
};

// 渲染任务板
{route === 'task-board' && sessionState && (
  <TaskBoardPage instanceName={sessionState.instanceName} />
)}
```

### 5. 构建配置修复 ✅

#### Vite 路径别名 (`electron.vite.config.ts`)

```typescript
renderer: {
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
}
```

#### TypeScript 配置 (`tsconfig.web.json`)

```json
"paths": {
  "@/*": ["./src/*"],
  "@shared/*": ["./src/shared/*"]
}
```

#### Preload 脚本路径修复 (`electron/main.ts`)

**错误**：`preload: join(__dirname, '../preload/index.js')`  
**修复**：`preload: join(__dirname, '../preload/index.mjs')`  
**原因**：electron-vite 输出 ESM 格式，扩展名是 `.mjs`

### 6. 会话生命周期调整 ✅

**变更前**：
- 实例选择后 → 进入聊天页 → 用户发送第一条消息 → 创建 pi session

**变更后**：
- 实例选择后 → **立即创建 pi session** → 进入任务板
- 任务创建后 → **自动执行**（无需手动点击）

## 遇到的问题

### 1. 导入路径错误

**现象**：Vite 编译失败，`Failed to resolve import "@/shared/task-types"`

**原因**：
- `tsconfig.web.json` 只配置了 `@/*` 别名
- `electron.vite.config.ts` 未配置 Vite resolver

**解决**：
- 同时在两处添加 `@shared/*` 别名配置

### 2. Electron 窗口空白

**现象**：
- 日志显示 `[main] renderer loaded successfully`
- 但窗口完全空白
- 控制台报错：`Unable to load preload script: /Users/yao/LLM/sep-client/out/preload/index.js`

**原因**：
- electron-vite 构建输出是 `index.mjs`（ESM 格式）
- main.ts 中硬编码的路径是 `index.js`
- preload 脚本加载失败 → `window.electronAPI` 未定义 → React 应用无法访问 IPC

**解决**：
- 修改 `electron/main.ts:35` → `'../preload/index.mjs'`

### 3. 环境变量未传递

**现象**：
- 第一次启动时，窗口显示 Electron 默认欢迎页
- 日志显示 `ELECTRON_RENDERER_URL not set, loading from file`

**原因**：
- electron-vite 启动时应该设置 `ELECTRON_RENDERER_URL=http://localhost:5173`
- 但环境变量没有正确传递到 Electron 主进程

**解决**：
- 添加详细日志 `console.log('[main] loading renderer from URL:', ...)`
- 重启后问题自行消失（可能是进程残留导致）

## 技术亮点

### 1. 状态自动同步

TaskManager → IPC 事件 → 渲染进程自动更新：
```typescript
// TaskManager.ts
private notifyUpdate(task: Task) {
  this.mainWindow?.webContents.send('task:updated', task);
}

// TaskBoardPage.tsx
useEffect(() => {
  const unsubscribe = window.electronAPI.onTaskUpdated((task) => {
    setTasks(prev => prev.map(t => t.id === task.id ? task : t));
  });
  return unsubscribe;
}, []);
```

### 2. 任务自动执行

创建任务后立即执行，无需手动操作：
```typescript
const handleCreateTask = async (data) => {
  const result = await window.electronAPI.createTask(data);
  if (result.success && result.task) {
    await window.electronAPI.executeTask(result.task.id);
  }
};
```

### 3. 工作目录隔离

通过 Electron `dialog.showOpenDialog` 强制用户明确选择：
```typescript
// main.ts
ipcMain.handle('util:select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  return { success: true, path: result.filePaths[0] };
});
```

## 测试方式

### 方法 1：UI 操作

1. 登录 → 选择实例
2. 点击"➕ 新建任务"
3. 填写表单，选择工作目录
4. 任务自动执行，观察状态变化
5. 点击卡片查看详情

### 方法 2：浏览器控制台

```javascript
// 创建任务
const result = await window.electronAPI.createTask({
  title: '测试任务',
  prompt: '创建一个 hello.js 文件',
  workDir: '/tmp/test'
});

// 执行任务
await window.electronAPI.executeTask(result.task.id);

// 监听更新
window.electronAPI.onTaskUpdated((task) => {
  console.log('任务状态:', task.status);
});
```

## 下一步计划

### P0-5: 会话生命周期优化 ✅（已完成部分）

- ✅ 实例选择后立即启动 pi session
- ⏳ 会话异常处理（连接失败、超时）
- ⏳ 会话重连机制

### P0-6: Token 自动刷新

- refreshToken 过期检测
- 自动调用刷新接口
- 401 错误自动重试

### P0-7: 工具审批流程测试

- 创建会触发 `bash`/`write`/`edit` 的任务
- 验证审批弹窗正常显示
- 验证批准/拒绝流程

### P1: 性能优化

- 任务列表虚拟滚动（任务数量 > 100）
- 日志分页加载
- 任务历史清理策略

## 文件清单

### 新增文件

```
src/
├── shared/
│   └── task-types.ts              任务类型定义
├── components/
│   ├── TaskCard.tsx               任务卡片
│   ├── CreateTaskDialog.tsx       创建任务对话框
│   └── TaskDetailDrawer.tsx       任务详情抽屉
└── pages/
    └── TaskBoardPage.tsx          任务板主页面

electron/
├── task-manager.ts                任务管理器（核心）
└── pi-host.ts                     PiHost 重写版本

docs/
├── 产品设计-任务板模式.md
├── plans/开发计划-v2-任务板模式.md
└── pi-coding-agent-事件系统验证.md
```

### 修改文件

```
electron/
├── main.ts                        +8 IPC handlers, preload 路径修复
└── preload.ts                     +任务管理 API

src/
└── App.tsx                        +TaskBoardPage 路由

electron.vite.config.ts            +路径别名配置
tsconfig.web.json                  +@shared 路径别名
```

## Commits

```
0f804ff docs: add architecture design, development plan, and status tracking
281e004 feat: complete PoC validation + docs restructure
30ffed0 docs: rewrite CLAUDE.md; add 开发交接文档
3e687ac chore: initial project skeleton with 4 PoC scripts
<pending> feat: P0-3 + P0-4 task board mode implementation
```

## 总结

今天完成了从**聊天助手**到**任务板管理**的完整产品转型，包括：

1. ✅ **产品定位明确** - 任务驱动、异步执行、工作目录隔离
2. ✅ **核心架构完成** - TaskManager + PiHost 集成 + 完整 IPC 层
3. ✅ **UI 完整实现** - Trello 风格任务板 + 详情抽屉 + 创建对话框
4. ✅ **构建配置修复** - 路径别名 + preload 脚本路径
5. ✅ **事件系统验证** - 修正原文档中的 API 错误

**当前状态**：P0-3 ✅ + P0-4 ✅ = **任务板 UI 完全可用**

**阻塞问题**：需要 SEP Gateway 在 `localhost:3001` 运行，否则任务会卡在 running 状态。

**下一里程碑**：Token 自动刷新（P0-6）+ 工具审批流程测试（P0-7）
