# SEP Client 开发交接文档

**日期**: 2026-07-30  
**阶段**: PoC 验证完成，UI 开发待启动  
**仓库**: https://github.com/yaoruiquan/sep-client  
**本地路径**: `/Users/yao/LLM/sep-client`

---

## 项目背景

sep-client 是 Silicon Employee Platform (SEP) 的桌面客户端。用户本地运行此应用，通过它与 AI 员工对话。核心技术选型是 **Electron + pi-coding-agent SDK**，SDK 运行在 Electron 主进程内（不是 sidecar 进程）。

详细技术背景见 `docs/对接/SEP客户端-项目交接文档.md`（原始交接文档）。

---

## 当前状态

### PoC 验证结果（全部通过）

本周目标是验证4个技术可行性，再开始 UI 开发。截至交接日，全部通过：

| PoC | 验证目标 | 状态 | 脚本 |
|-----|---------|------|------|
| ① | SDK import + `createAgentSession` 能正常初始化 | ✅ PASS | `poc/01-sdk-import.ts` |
| ② | `before_provider_headers` 事件能动态注入 token | ✅ PASS | `poc/02-provider.ts` |
| ③ | `tool_call` async handler 能 await 200ms 再返回 block | ✅ PASS | `poc/03-tool-call-async.ts` |
| ④ | 401 错误能冒泡（不被静默吞掉） | ✅ PASS | `poc/04-failure.ts` |

运行方式：

```bash
npm install
npm run poc:01
npm run poc:02
npm run poc:03
npm run poc:04
```

---

## 关键 API 修正（原文档与实际不符）

运行 PoC 过程中发现原交接文档在以下三点有误。**以此处为准。**

### 1. `createAgentSession` 返回 result 对象

原文档示例直接 `const session = await createAgentSession(...)` 会得到一个包含 `session` 字段的对象，而不是 session 本身。

```typescript
// 正确
const { session } = await createAgentSession({ ... });
```

### 2. `DefaultResourceLoader` 必须传 `cwd` / `agentDir`，且必须调用 `reload()`

构造时不传 `cwd` 会在内部 `normalizePath` 处崩溃；不调用 `reload()` 则 `extensionFactories` 不会被加载，extension 静默失效。

```typescript
const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: '.pi',
  extensionFactories: [...],
  noSkills: true,
  noContextFiles: true,
});
await resourceLoader.reload();   // 必须，否则 extension 不生效
const { session } = await createAgentSession({ resourceLoader, ... });
```

### 3. session 事件订阅用 `subscribe()`，不是 `on()`

`AgentSession` 没有 `.on()` 方法，订阅用 `.subscribe(listener)`，所有事件类型通过回调参数的 `event.type` 区分。

```typescript
session.subscribe((event) => {
  if (event.type === 'agent_settled') { /* 本轮完成 */ }
  if (event.type === 'agent_end') { console.log(event.willRetry); }
  if (event.type === 'auto_retry_start') { /* 正在重试 */ }
});
```

---

## 已完成的代码结构

```
sep-client/
├── electron/
│   ├── main.ts          BrowserWindow 创建、IPC handlers 注册
│   ├── preload.ts       contextBridge 暴露 ElectronAPI 接口
│   ├── pi-host.ts       PiHost 类 — session 生命周期管理
│   └── credentials.ts   refresh token 加密存储（safeStorage）
├── pi-extension/
│   ├── index.ts         buildSepExtensions(config) — 对外入口
│   ├── guard.ts         工具审批拦截（bash/write/edit 需用户确认）
│   └── provider.ts      动态 token 注入（before_provider_headers）
├── src/
│   ├── App.tsx          UI 框架：PoC 状态看板 + 会话控制 + 工具审批弹窗
│   ├── main.tsx
│   └── shared/types.ts  主进程和渲染进程共享的 TypeScript 类型
├── poc/                 验证脚本（已全部通过，保留作回归测试）
├── package.json         "type": "module" — ESM 模式必须
├── CLAUDE.md            AI 工作指南（含 API 修正）
└── README.md
```

### electron/preload.ts 暴露的 API 接口

```typescript
interface ElectronAPI {
  startSession(config: SessionConfig): Promise<{ ok: boolean }>;
  sendPrompt(text: string): Promise<{ ok: boolean }>;
  stopSession(): Promise<{ ok: boolean }>;
  saveRefreshToken(token: string): Promise<void>;
  getRefreshToken(): Promise<string | null>;
  onPiEvent(callback: (event: PiClientEvent) => void): () => void;        // 返回 cleanup
  onToolApprovalRequest(callback: (req: ToolApprovalRequest) => void): () => void;
  sendToolApprovalResponse(response: { approved: boolean }): void;
}
```

---

## 安全边界

- **主进程**: 持有 refresh token（safeStorage 加密）、持有 pi session、可访问 Node.js API
- **渲染进程**: 不可见任何 token 值，只能通过 `window.electronAPI.*` 与主进程通信
- **工具审批**: bash / write / edit 默认要求用户确认，超时 60 秒自动拒绝，其余工具默认 block
- **nodeIntegration**: 始终为 false，contextBridge 是唯一通道

---

## 下一步开发顺序

### Phase 1 — 核心 UI（推荐先做）

1. **登录流程** — OAuth / refresh token 获取、safeStorage 存储、token 自动刷新
2. **会话界面** — 启动 pi session、发送 prompt、流式显示 LLM 输出
3. **工具审批弹窗** — 拦截 tool_call，渲染工具入参，用户 approve/deny

### Phase 2 — 完善体验

4. **多轮会话** — 历史消息展示、session 恢复
5. **错误处理** — 401 自动刷新 token、网络断线重连提示
6. **设置页** — 配置 SEP Gateway URL、查看连接状态

### Phase 3 — 发版准备

7. **打包** — `electron-builder` 构建 macOS / Windows 安装包
8. **自动更新** — electron-updater 集成

---

## 环境变量

应用启动时主进程从 `.env` 读取（开发）或系统环境（生产）：

| 变量 | 说明 | 示例 |
|------|------|------|
| `SEP_GATEWAY_URL` | SEP AI Gateway 地址 | `https://gateway.sep.example.com` |

refresh token 不走环境变量，通过登录流程获取后存入 safeStorage。

---

## 依赖注意事项

- `@earendil-works/pi-coding-agent@0.83.0` 和 `@earendil-works/pi-ai@0.83.0` **版本锁定**，不能随意升级。
- 如需升级，必须重新跑全部 4 个 PoC 确认接口兼容性。
- 项目使用 `"type": "module"`（ESM），tsx PoC 脚本和 electron-vite 均依赖这一设置，不可删除。

---

## 参考文档

| 文档 | 路径 |
|------|------|
| 原始技术交接文档 | `docs/对接/SEP客户端-项目交接文档.md` |
| 开发顺序方案 v3 | `docs/plans/项目升级开发顺序方案v3.md` |
| pi-coding-agent 类型定义 | `node_modules/@earendil-works/pi-coding-agent/dist/*.d.ts` |
| AI 工作指南（含 API 修正） | `CLAUDE.md` |
