# Pi-Coding-Agent 事件系统验证

**验证时间**: 2026-07-30  
**SDK 版本**: @earendil-works/pi-coding-agent@0.83.0

---

## 核心 API 验证

### 1. Session 创建和订阅

**正确方式** (从 PoC 脚本验证):
```typescript
const { session } = await createAgentSession({
  modelRuntime,
  model,
  resourceLoader,
  sessionManager: SessionManager.inMemory(),
});

// 使用 subscribe() 而不是 on()
session.subscribe((event) => {
  if (event.type === 'agent_settled') {
    console.log('任务完成');
  }
});

// 发送 prompt
session.prompt('用户的消息');
```

**错误方式** (pi-host.ts 中的错误实现):
```typescript
// ❌ 错误：session.on() 方法不存在
this.session.on('agent_start', (e) => { ... });
```

---

## 可用的事件类型

从 PoC 脚本和错误代码中整理出的事件列表：

### 核心事件

| 事件类型 | 触发时机 | 用途 |
|---------|---------|------|
| `agent_start` | AI 开始处理请求 | 更新任务状态为 `running` |
| `agent_settled` | AI 完成一轮处理 | 更新任务状态为 `completed` |
| `agent_end` | 一轮对话结束 | 检查是否有错误或需要重试 |
| `auto_retry_start` | 自动重试开始 | 记录重试日志 |
| `auto_retry_end` | 自动重试结束 | 记录重试结果 |

### 消息事件

| 事件类型 | 触发时机 | 用途 |
|---------|---------|------|
| `message_start` | 消息开始生成 | 初始化消息容器 |
| `message_update` | 消息流式更新 | 实时显示 AI 输出（任务板模式可能不需要） |
| `message_end` | 消息生成完成 | 保存完整消息 |

### 工具执行事件

| 事件类型 | 触发时机 | 用途 |
|---------|---------|------|
| `tool_execution_start` | 工具开始执行 | 记录日志：`执行工具: bash` |
| `tool_execution_end` | 工具执行完成 | 记录日志：`工具执行完成` |

---

## 任务板模式下的事件映射

### 任务状态机

```
pending (待处理)
  ↓
running (进行中) ← agent_start
  ↓
  ├─→ waiting_approval (等待审批) ← tool_call (在 extension 中)
  │    ↓
  │  running (继续) ← 用户批准
  │
  ├─→ completed (已完成) ← agent_settled
  │
  ├─→ failed (失败) ← agent_end (有错误)
  │
  └─→ paused (暂停) ← 用户操作
```

### 事件处理伪代码

```typescript
session.subscribe((event) => {
  const currentTask = taskManager.getCurrentTask();
  
  switch (event.type) {
    case 'agent_start':
      taskManager.updateStatus(currentTask.id, 'running');
      taskManager.addLog(currentTask.id, 'AI 开始处理任务');
      break;
      
    case 'agent_settled':
      taskManager.updateStatus(currentTask.id, 'completed');
      taskManager.addLog(currentTask.id, '任务完成');
      sendNotification('任务完成', currentTask.title);
      break;
      
    case 'agent_end':
      // 检查是否有错误
      if (event.error) {
        taskManager.updateStatus(currentTask.id, 'failed');
        taskManager.addLog(currentTask.id, `错误: ${event.error}`, 'error');
      }
      // 检查是否会重试
      if (event.willRetry) {
        taskManager.addLog(currentTask.id, 'AI 将自动重试');
      }
      break;
      
    case 'auto_retry_start':
      taskManager.addLog(currentTask.id, '开始自动重试');
      break;
      
    case 'tool_execution_start':
      taskManager.addLog(currentTask.id, `执行工具: ${event.toolName}`);
      break;
      
    case 'tool_execution_end':
      taskManager.addLog(currentTask.id, `工具执行完成: ${event.toolName}`);
      break;
      
    case 'message_update':
      // 可选：记录 AI 的思考过程
      // 任务板模式可能不需要实时显示消息内容
      break;
  }
});
```

---

## 工具审批事件

工具审批不是通过 `session.subscribe()` 处理，而是通过 **Extension** 的 `tool_call` 事件：

```typescript
// pi-extension/guard.ts
pi.on('tool_call', async (event: ToolCallEvent): Promise<ToolCallEventResult> => {
  // 这里可以更新任务状态为 waiting_approval
  taskManager.updateStatus(currentTask.id, 'waiting_approval');
  
  // 异步等待用户批准
  const approved = await showApprovalDialog(event);
  
  // 批准后恢复任务
  if (approved) {
    taskManager.updateStatus(currentTask.id, 'running');
  }
  
  return approved ? { block: false } : { block: true };
});
```

---

## Pi-Host 需要修复的问题

### 问题 1: 使用了不存在的 session.on() 方法

**当前错误代码** (`electron/pi-host.ts:97-104`):
```typescript
this.session.on('agent_start', (e) => { ... });
this.session.on('agent_end', (e) => { ... });
// ❌ session.on() 方法不存在
```

**正确方式**:
```typescript
this.session.subscribe((event) => {
  switch (event.type) {
    case 'agent_start':
      this.config.onEvent({ type: 'agent_start', data: event });
      break;
    case 'agent_end':
      this.config.onEvent({ type: 'agent_end', data: event });
      break;
    // ... 其他事件
  }
});
```

### 问题 2: DefaultResourceLoader 缺少必需参数

**当前错误代码** (`electron/pi-host.ts:88`):
```typescript
resourceLoader: new DefaultResourceLoader({
  extensionFactories: extensions,
  noSkills: true,
  noContextFiles: true,
})
// ❌ 缺少 cwd 和 agentDir
```

**正确方式** (从 PoC 验证):
```typescript
resourceLoader: new DefaultResourceLoader({
  cwd: process.cwd(),           // 必需
  agentDir: '.pi',              // 必需
  extensionFactories: extensions,
  noSkills: true,
  noContextFiles: true,
})
```

### 问题 3: createAgentSession 返回值结构

**当前错误代码** (`electron/pi-host.ts:85`):
```typescript
this.session = await createAgentSession({ ... });
// ❌ 返回的是 { session, extensionsResult }，不是直接的 session
```

**正确方式**:
```typescript
const { session } = await createAgentSession({ ... });
this.session = session;
```

---

## 下一步行动

### 立即修复 (P0-3 开发前)

1. **修复 pi-host.ts**
   - 改用 `session.subscribe()` 而不是 `session.on()`
   - 添加 `cwd` 和 `agentDir` 参数
   - 正确解构 `createAgentSession` 返回值

2. **验证修复**
   - 运行 `npm run poc:02` 确认 PoC 脚本通过
   - 测试实例选择后 session 能否正常启动

### P0-3 开发时使用

使用验证过的事件系统实现任务状态管理：
- `agent_start` → `task.status = 'running'`
- `agent_settled` → `task.status = 'completed'`
- `agent_end` (error) → `task.status = 'failed'`
- `tool_call` (在 extension 中) → `task.status = 'waiting_approval'`

---

## 参考 PoC 脚本

验证通过的脚本：
- `poc/02-provider.ts` - session.subscribe() 用法
- `poc/04-failure.ts` - agent_end 和 auto_retry 事件
- `poc/03-tool-call-async.ts` - 工具审批异步等待

所有 PoC 脚本都使用 `session.subscribe()`，说明这是正确的 API。
