# SEP 客户端发行与联调开发计划 v1

> 文档状态：发行改造已完成首轮实现，进入签名、上传和真实安装联调阶段
>
> 更新时间：2026-09-20
>
> 适用仓库：`/Users/yao/LLM/sep-client`
>
> 关联仓库：`/Users/yao/LLM/SEP`
>
> 目标：把现有 Electron 客户端从“源码可运行 / 可构建”推进到“可供联调环境下载安装、可识别运行环境、可稳定对接 SEP API、可重复发布”的状态。

---

## 1. 结论摘要

### 1.1 当前客户端已经具备什么

`sep-client` 已经是一个真实的 Electron 桌面客户端，不是纯 PoC：

- Electron 主进程位于 `electron/`；
- React + TypeScript 渲染层位于 `src/`；
- 使用 `electron-vite` 构建；
- 使用 `electron-builder` 打包；
- 已配置 3 个目标产物：macOS Intel（x64）DMG、macOS Apple Silicon（arm64）DMG、Windows x64 NSIS 安装包；不构建 Linux 版本；
- 已实现客户端登录、refresh token、订阅列表、employment token、员工运行时、技能加载和本地任务执行；
- 已使用 Electron `safeStorage` 保存 refresh token，access token 保持在主进程内存；
- 已有本地任务持久化、任务运行记录、工具审批和任务状态机。

当前 `package.json` 已存在：

```bash
npm run dev
npm run build
npm run typecheck
npm run lint
npm run package
```

其中：

```bash
npm run package
```

会先执行 `electron-vite build`，再执行 `electron-builder`。

### 1.2 当前还没有达到发行条件的部分

当前仓库暂未形成可交付的正式发行链路：

- 本机已生成未签名的 `.dmg` 和 `.exe` 联调产物；尚未提交或上传发行物；
- `out/` 只是 Electron/Vite 的构建输出，不是最终安装包；
- `dist/` 尚未形成可交付版本，且发行目录被 `.gitignore` 忽略；
- `electron-builder` 尚未配置 `publish` 发布目标；
- 没有稳定的 `beta/stable` 发布通道；
- 没有版本清单或客户端自动更新清单；
- 没有 macOS Developer ID 签名和 notarization 配置；
- 没有 Windows Authenticode 签名配置；
- 没有统一的安装包命名、SHA-256 清单和 release notes 产物；
- 没有在打包产物中可靠注入联调环境 / 正式环境配置的完整方案；
- 客户端当前只发现了认证、订阅、runtime 等平台请求，尚未发现对 `POST /api/client/tasks`、状态、heartbeat、events 等云端任务镜像接口的调用。

因此当前阶段不是“要不要上架应用商店”的问题，而是要先完成：

```text
可重复构建
→ 生成安装包
→ 区分联调和正式环境
→ 上传下载地址
→ 安装后能登录联调环境
→ 任务监控链路能够真实上报
```

### 1.3 是否必须上架应用商店

**不必须。**

联调阶段直接通过官网下载页 + OSS/CDN 分发即可：

```text
官网下载页
    ↓
OSS/CDN 静态安装包
    ↓
用户下载安装
```

App Store、Microsoft Store 属于后续分发渠道，不是当前联调的前置条件；Linux 不在当前发行范围内。

但即使不进商店，也建议正式发布前完成：

- macOS Developer ID 签名 + Apple notarization；
- Windows 代码签名；
- HTTPS 下载；
- SHA-256 完整性校验；
- 版本回滚和问题版本下线能力。

---

## 2. 当前代码审计结果

### 2.1 技术栈与目录

| 区域 | 当前实现 |
|---|---|
| 桌面壳 | Electron `^33.4.11` |
| 渲染层 | React `^18.3.1` + TypeScript |
| 构建 | `electron-vite` |
| 打包 | `electron-builder` |
| AI 运行时 | `@earendil-works/pi-coding-agent` `0.83.0` |
| 状态 | Zustand |
| 本地认证存储 | Electron `safeStorage` |
| 主进程入口 | `electron/main.ts` |
| preload | `electron/preload.ts` |
| IPC 契约 | `src/shared/ipc.ts` |
| UI 入口 | `src/App.tsx` |
| 任务持久化 | `electron/tasks/task-store.ts`、`task-run-store.ts` |
| 订阅运行时 | `electron/runtime/subscription-runtime.ts` |
| 平台认证 API | `electron/auth/auth-api.ts` |
| 配置 | `electron/infrastructure/config.ts` |

### 2.2 当前构建配置

当前 `package.json` 的 `build` 字段已经配置：

```json
{
  "appId": "com.sep.client",
  "productName": "SEP Client",
  "directories": { "output": "dist" },
  "mac": { "target": [{ "target": "dmg", "arch": ["x64", "arm64"] }] },
  "win": { "target": [{ "target": "nsis", "arch": ["x64"] }] }
}
```

这说明客户端具备当前三种安装包的打包基础：

| 平台 | 当前目标 | 当前判断 |
|---|---|---|
| macOS Intel | `dmg`（x64） | 已生成本机联调包，待签名与安装验证 |
| macOS Apple Silicon | `dmg`（arm64） | 已生成本机联调包，待签名与安装验证 |
| Windows | `nsis`（x64） | 已生成本机联调包，待签名与安装验证 |

当前没有看到：

```json
"artifactName": "...",
"publish": { ... },
"icon": "...",
"afterSign": "...",
"notarize": "..."
```

因此发行改造要补充“产物命名、发布目标、签名、公证和版本清单”层，而不是重新选择 Electron 技术栈。

### 2.3 当前环境配置

`electron/infrastructure/config.ts` 当前核心配置为：

```text
SEP_BASE_URL
SEP_API_BASE_URL = ${SEP_BASE_URL}/api
SEP_GATEWAY_URL
SEP_DEFAULT_MODEL
CLIENT_VERSION
```

默认地址是本机：

```text
SEP_BASE_URL=http://localhost:3001
```

这适合本地开发，不适合直接作为联调安装包的默认值。联调发行包必须明确写入或加载：

```text
SEP_BASE_URL=<联调环境地址>
SEP_GATEWAY_URL=<联调网关地址>
环境标识=beta/dev
```

正式发行包则使用：

```text
SEP_BASE_URL=<正式环境地址>
SEP_GATEWAY_URL=<正式网关地址>
环境标识=stable/prod
```

> 注意：当前项目没有把 `.env` 自动打进发行包的完整机制。不能假设用户安装后会自动拥有开发机上的环境变量。发行环境配置需要在构建时注入，或生成受控的外部配置文件。

### 2.4 当前平台接口对接情况

客户端已经调用或具备调用结构的接口包括：

```http
POST /api/client/auth/login
POST /api/client/auth/refresh
POST /api/client/auth/token
GET  /api/client/subscriptions
GET  /api/client/instances              # 兼容回退
GET  /api/enterprise/subscriptions/:subscriptionId/package
GET  /api/enterprise/subscriptions/:subscriptionId/skills
GET  /api/enterprise/skill-versions/:versionId/preview
```

当前平台后端已经提供任务云端镜像接口：

```http
POST  /api/client/tasks
PATCH /api/client/tasks/:id/status
POST  /api/client/tasks/:id/heartbeat
POST  /api/client/tasks/:id/events
GET   /api/client/tasks
GET   /api/client/tasks/:id
```

但在当前客户端源码中尚未发现对应的任务镜像 HTTP 客户端模块或调用链。因此需要把云端监控作为本计划中的独立开发项接入。

### 2.5 客户端当前任务模型与云端模型的关系

客户端本地任务由以下模块负责：

```text
electron/tasks/task-manager.ts
electron/tasks/task-store.ts
electron/tasks/task-run-store.ts
electron/tasks/task-execution-coordinator.ts
electron/tasks/domain/task-state-machine.ts
```

客户端本地任务状态更适合驱动 UI 和本地恢复；云端任务镜像只应上传必要的摘要信息：

```text
clientTaskId
clientRunId
subscriptionId
title
taskType
modelId
clientVersion
status
progress
currentStep
activity
errorSummary
startedAt
completedAt
heartbeat
事件序号和摘要
```

默认不上传：

```text
完整 prompt
完整模型响应
本地文件内容
本地工作目录内容
refreshToken
accessToken
employmentToken
上游模型密钥
```

---

## 3. 目标架构

### 3.1 客户端运行架构

```text
官网 / 下载页
      │
      ▼
OSS/CDN 安装包
      │
      ▼
Electron 客户端
      │
      ├─ Renderer：页面、登录表单、任务视图
      │       │
      │       └─ contextBridge / IPC
      │
      └─ Main：认证、配置、任务执行、云端上报、token 管理
              │
              ├─ SEP REST API
              │   ├─ /api/client/auth/*
              │   ├─ /api/client/subscriptions
              │   └─ /api/client/tasks/*
              │
              └─ SEP Gateway
                  └─ AI 模型调用
```

### 3.2 责任边界

| 能力 | 客户端负责 | SEP 后端负责 |
|---|---|---|
| 用户登录 | 收集凭据、保存 refresh token、刷新 access token | 校验账号、设备和企业关系 |
| 员工订阅 | 拉取并展示订阅 | 校验授权和返回订阅清单 |
| 员工运行时 | 缓存员工包、技能和隔离目录 | 返回授权版本和审核内容 |
| 本地任务 | 创建、执行、暂停、恢复、取消、持久化 | 保存任务镜像和企业可见监控数据 |
| 实时进度 | 从本地运行时获取真实状态 | 接收 heartbeat / status / event 并提供企业端查询 |
| 模型调用 | 使用 employment token 调用网关 | 授权模型、计量和路由 |
| 安装升级 | 检查版本、下载更新、安装或提示重启 | 提供版本清单和发行物地址 |

---

## 4. 分阶段开发计划

## P0：产出第一份可联调安装包

### 目标

让客户端开发和测试人员可以在目标平台安装客户端，并连到联调环境完成登录和订阅加载。

### 任务清单

#### P0.1 固化版本信息

- 确认当前版本号策略：建议从 `package.json` 读取，不允许同时维护多个手写版本号；
- 为联调版本采用明确后缀，例如：

```text
0.1.0-beta.1
```

- 在“关于”或设置页展示：

```text
客户端版本
构建环境
SEP API 地址（可脱敏展示）
构建时间
```

#### P0.2 增加发行配置

建议新增独立发行配置，不把联调地址写死在业务代码里：

```text
config/release.beta.json
config/release.stable.json
```

至少包含：

```json
{
  "channel": "beta",
  "environment": "integration",
  "sepBaseUrl": "https://<联调域名>",
  "gatewayUrl": "https://<联调域名>/api/gateway/v1"
}
```

实现时可选两种方式：

1. 构建时生成 `runtime-config.json` 并打包进去；
2. 由主进程根据构建变量生成静态配置模块。

推荐第一种，方便检查最终产物中的环境信息。

#### P0.3 真实执行打包

在客户端仓库执行：

```bash
npm ci
npm run typecheck
npm run lint
npm run build
npm run package
```

预期得到：

```text
dist/
├── SEP-Client-<version>-mac-x64.dmg
├── SEP-Client-<version>-mac-arm64.dmg
└── SEP-Client-<version>-win-x64.exe
```

最终文件名以 electron-builder 实际输出为准；后续应通过 `artifactName` 固化为团队约定格式。

#### P0.4 本机安装验证

至少验证：

- macOS：DMG 可以打开、安装、启动；
- Windows：NSIS 安装器可以安装、卸载、重新安装；
- 首次启动不依赖开发机的 `node_modules`、源码目录和环境变量；
- 应用数据目录可正常写入；
- refresh token 可写入系统安全存储；
- 客户端退出后重新启动可以恢复登录状态；
- 网络不可用时能展示可理解的错误；
- 版本和环境显示正确。

#### P0.5 上传联调包

把联调安装包上传到单独的 beta 路径，例如：

```text
client/beta/<version>/macos/x64/...
client/beta/<version>/macos/arm64/...
client/beta/<version>/windows/x64/...
```

不要上传到正式 stable 路径，也不要把安装包提交到 Git 仓库。

### P0 验收标准

```text
[ ] 至少 macOS 或 Windows 有可安装包
[ ] 安装后默认连接联调环境
[ ] 可以登录
[ ] 可以获取订阅列表
[ ] 可以加载一个订阅的 runtime
[ ] 可以启动一个本地任务
[ ] 版本号和环境标识可见
[ ] 安装包 SHA-256 已记录
[ ] 安装包下载地址可交给 Web 端
```

---

## P1：接入客户端任务云端监控

### 目标

让客户端本地任务的关键生命周期同步到 SEP 后端，并在企业 Web 的客户端监控页面可见。

### P1.1 新增主进程平台 API 模块

建议新增：

```text
electron/tasks/client-task-api.ts
```

该模块只负责 HTTP 请求，不负责任务状态决策。建议提供：

```ts
createRemoteTask(input, accessToken)
updateRemoteTaskStatus(remoteTaskId, input, accessToken)
sendRemoteTaskHeartbeat(remoteTaskId, input, accessToken)
sendRemoteTaskEvent(remoteTaskId, input, accessToken)
```

请求统一使用：

```http
Authorization: Bearer <accessToken>
Content-Type: application/json
```

access token 获取和刷新必须复用现有 `AuthSessionManager`，不要在任务模块自行保存 refresh token。

### P1.2 新增云端镜像状态机适配器

建议新增：

```text
electron/tasks/task-cloud-mirror.ts
electron/tasks/task-cloud-mirror-queue.ts
```

职责：

- 本地任务创建后创建云端镜像；
- 本地状态变化后上报云端状态；
- 执行中按固定周期上报 heartbeat；
- 关键执行事件按顺序上报；
- 网络失败时进入内存队列或磁盘补偿队列；
- 不阻塞本地任务执行；
- 任务结束时尽最大努力补发最终状态；
- 401 时触发统一 access token 刷新后重试一次；
- 403/404 时停止继续上报并记录诊断信息；
- 429/5xx/网络错误采用指数退避。

推荐原则：

```text
本地任务执行是主链路
云端监控是旁路链路
云端暂时不可用不能导致本地任务直接失败
```

### P1.3 事件映射

本地状态到云端状态建议按以下方式映射：

| 本地语义 | 云端 `status` |
|---|---|
| 等待执行 | `QUEUED` |
| 执行中 | `RUNNING` |
| 等待工具审批 | `WAITING_APPROVAL` |
| 暂停 | `PAUSED` |
| 成功 | `COMPLETED` |
| 执行异常 | `FAILED` |
| 用户取消 | `CANCELLED` |

云端任务创建请求：

```http
POST /api/client/tasks
```

```json
{
  "clientTaskId": "local-task-id",
  "clientRunId": "local-run-id",
  "subscriptionId": "subscription-id",
  "title": "任务标题",
  "taskType": "chat",
  "modelId": "gpt-5.2",
  "clientVersion": "0.1.0-beta.1"
}
```

状态更新请求：

```http
PATCH /api/client/tasks/{remoteTaskId}/status
```

```json
{
  "status": "RUNNING",
  "progress": 35,
  "currentStep": "正在生成结果",
  "activity": "调用技能：xxx",
  "errorSummary": null,
  "startedAt": "2026-09-20T10:00:00.000Z",
  "completedAt": null
}
```

heartbeat 请求：

```http
POST /api/client/tasks/{remoteTaskId}/heartbeat
```

```json
{
  "progress": 35,
  "currentStep": "正在生成结果",
  "activity": "模型流式输出中",
  "clientVersion": "0.1.0-beta.1"
}
```

事件请求：

```http
POST /api/client/tasks/{remoteTaskId}/events
```

```json
{
  "sequence": 4,
  "type": "STEP_STARTED",
  "stepKey": "draft",
  "message": "开始生成草稿",
  "progress": 20,
  "occurredAt": "2026-09-20T10:00:02.000Z"
}
```

### P1.4 heartbeat 策略

建议默认：

```text
执行中：每 10 秒一次
等待审批：每 15 秒一次
暂停：不必高频发送，可在状态变化时发送一次
已结束：发送最终 status，不再发送 heartbeat
```

具体间隔应抽成配置常量，避免散落在任务执行代码中。

heartbeat 不应包含：

```text
完整日志
模型原始响应
敏感输入
本地文件内容
```

### P1.5 事件去重和补偿

客户端必须为每个本地任务运行维护：

```text
remoteTaskId
clientRunId
lastEventSequence
lastMirroredStatus
lastHeartbeatAt
pendingEvents
```

事件 `sequence` 必须单调递增。网络重试可能导致重复请求，因此客户端和后端都要按：

```text
remoteTaskId + sequence
```

进行幂等处理。

### P1 验收标准

```text
[ ] 创建本地任务后能创建云端镜像
[ ] QUEUED/RUNNING/COMPLETED 能正确同步
[ ] FAILED/CANCELLED 能正确同步
[ ] WAITING_APPROVAL/PAUSED 能正确同步
[ ] heartbeat 每 10 秒左右到达
[ ] 企业 Web 查询能看到任务
[ ] 网络断开时本地任务仍可运行
[ ] 网络恢复后状态和事件可补发
[ ] 401 能刷新 token 后重试
[ ] 重复事件不会造成云端重复记录
[ ] 客户端退出后不会泄露 token
```

---

## P2：形成 beta/stable 发布体系

### 目标

让客户端发布不再依赖人工在官网代码里替换下载链接。

### P2.1 发布目录

建议使用 OSS/CDN 独立域名，例如：

```text
https://download.<domain>/client/
```

目录建议：

```text
client/
├── beta/
│   ├── 0.1.0-beta.1/
│   │   ├── macos/x64/
│   │   ├── macos/arm64/
│   │   ├── windows/x64/
│   │   ├── checksums.txt
│   │   └── release-notes.md
│   └── latest.json
└── stable/
    ├── 1.0.0/
    │   ├── macos/x64/
    │   ├── macos/arm64/
    │   ├── windows/x64/
    │   ├── checksums.txt
    │   └── release-notes.md
    └── latest.json
```

### P2.2 版本清单

建议先使用静态 JSON，不急于新增数据库：

```json
{
  "channel": "beta",
  "version": "0.1.0-beta.1",
  "publishedAt": "2026-09-20T10:00:00+08:00",
  "minimumServerVersion": "0.2.0",
  "releases": {
    "macos": {
      "arm64": {
        "url": "https://download.<domain>/client/beta/0.1.0-beta.1/macos/SEP-Client.dmg",
        "sha256": "...",
        "size": 123456789
      }
    },
    "windows": {
      "x64": {
        "url": "https://download.<domain>/client/beta/0.1.0-beta.1/windows/SEP-Client-Setup.exe",
        "sha256": "...",
        "size": 123456789
      }
    }
  },
  "releaseNotes": [
    "完成联调环境登录和任务监控上报"
  ]
}
```

### P2.3 自动更新

自动更新不是 P0 的前置条件。建议顺序：

```text
P0：官网手动下载安装
P1：版本页展示最新版本
P2：客户端检查 latest.json
P3：下载、校验、提示重启
P4：灰度和回滚
```

在自动更新上线前，必须先确认：

- 更新包来源可信；
- 下载地址 HTTPS；
- SHA-512/签名校验；
- 旧版本回滚；
- beta 不会覆盖 stable；
- 更新失败不会破坏用户本地任务数据。

---

## 5. 打包、签名和发布要求

### 5.1 发行物要求

每次发行只生成以下 3 个安装包：

```text
macOS Intel：DMG（x64）
macOS Apple Silicon：DMG（arm64）
Windows：NSIS EXE（x64）
checksums.txt
release-notes.md
latest.json 或对应版本 JSON
```

### 5.2 macOS

正式发布建议：

- Apple Developer Team；
- Developer ID Application 证书；
- Developer ID Installer（如采用安装器）；
- notarization；
- stapling；
- 对 Apple Silicon 和 Intel 明确架构策略；
- 首期建议 universal，若构建成本或原生依赖限制，则分别提供 arm64/x64。

联调阶段可以先不签名，但要在下载页明确：

```text
这是联调 beta 版本，首次打开可能需要在系统设置中允许打开。
```

### 5.3 Windows

正式发布建议：

- Authenticode 代码签名证书；
- 固定发行商名称；
- 安装包升级和卸载测试；
- Windows Defender / SmartScreen 风险验证；
- 明确 x64/ARM64 支持范围。

### 5.4 Linux（当前不发行）

Linux 不属于当前发行范围，不生成 AppImage、deb、rpm 或其他 Linux 安装包。后续如客户提出 Linux 需求，另行评估目标格式、运行时兼容性和测试矩阵，不影响当前 macOS/Windows 发行链路。

### 5.5 SHA-256

上传后为每个文件计算：

```bash
shasum -a 256 <file>
```

或：

```bash
sha256sum <file>
```

下载页和客户端自检信息必须使用同一份摘要，不能手工复制多份不一致的值。

---

## 6. 测试计划

### 6.1 静态检查

```bash
npm ci
npm run typecheck
npm run lint
npm run build
```

### 6.2 打包检查

```bash
npm run package
```

检查：

- `dist/` 产物完整；
- 文件名、版本号、架构正确；
- 产物大小无异常；
- 没有把 `.env`、密钥、源码地图或测试账号打包进去；
- 安装包能在干净机器启动。

### 6.3 平台启动检查

| 项目 | macOS Intel / Apple Silicon | Windows x64 |
|---|---:|---:|
| 安装 | 必测 | 必测 |
| 卸载 | 必测 | 必测 |
| 首次登录 | 必测 | 必测 |
| 重启恢复登录 | 必测 | 必测 |
| 获取订阅 | 必测 | 必测 |
| 本地任务执行 | 必测 | 必测 |
| 云端监控 | 必测 | 必测 |
| 网络断开恢复 | 必测 | 必测 |
| 升级覆盖安装 | P2 | P2 |

### 6.4 联调链路检查

```text
安装包下载
→ 安装
→ 启动
→ 登录
→ 获取订阅
→ 加载员工 runtime
→ 创建本地任务
→ 创建云端任务镜像
→ 上报 RUNNING
→ heartbeat
→ 上报事件
→ 上报 COMPLETED/FAILED
→ Web 企业端可查询
```

---

## 7. 发布流程

### 联调 beta 发布

```text
1. 修改 package.json 版本号
2. 选择 beta 配置
3. npm ci
4. npm run typecheck
5. npm run lint
6. npm run build
7. npm run package
8. 在干净机器安装验证
9. 计算 SHA-256
10. 上传 OSS/CDN beta 路径
11. 更新 latest.json
12. 把下载地址和校验值交给 Web 端
13. 做一次完整登录和任务监控联调
```

### 正式 stable 发布

```text
1. 从 beta 验收结果生成正式版本
2. 使用生产环境配置构建
3. 完成 macOS notarization / Windows 签名
4. 生成发行物和校验清单
5. 上传 stable 版本目录
6. 更新 stable/latest.json
7. 官网切换 stable 展示
8. 保留上一版本，准备回滚
9. 观察错误日志和下载反馈
```

---

## 8. 风险和禁止事项

### 风险

- 联调包误连接生产环境；
- 正式包误连接 localhost；
- Electron 原生依赖导致不同平台启动失败；
- 未签名安装包触发系统拦截；
- 自动更新覆盖错误版本；
- 网络失败阻塞本地任务；
- 云端任务镜像重复上报造成重复事件；
- 打包时把测试账号或 API key 带入产物；
- 本地任务数据因升级被覆盖。

### 禁止事项

- 不把 `SUB2API_API_KEY`、模型密钥或 refresh token 写进安装包；
- 不把安装包提交进 Git；
- 不把安装包存进 PostgreSQL；
- 不通过 NestJS 业务进程代理所有大文件下载；
- 不把 beta 包放到 stable 地址；
- 不让 renderer 直接持有 access token 或 refresh token；
- 不让云端监控失败直接导致本地任务失败；
- 不在任务事件中上传完整 prompt、响应或本地文件内容。

---

## 9. 需要客户端团队最终确认的事项

在开始 P0 实现前，需要确定：

1. 联调环境正式域名；
2. 正式环境 API 域名；
3. 是否确认当前只发布 macOS x64、macOS arm64 和 Windows x64；
4. macOS 是否需要改为 universal；
5. Windows 是否保持只支持 x64；
6. 首期是否签名；
7. 下载域名和 OSS/CDN 归属；
8. 是否先做手动下载，还是 P0 就包含自动更新；
9. 任务监控 heartbeat 周期；
10. 客户端本地任务和云端任务镜像的唯一 ID 规则；
11. 联调版是否允许测试账号快捷登录；
12. 是否需要在客户端设置页切换环境。

---

## 10. 本计划完成后的交付物

```text
客户端源码：
- 发行环境配置
- 稳定的打包命令
- 任务云端镜像 API 模块
- heartbeat 和事件补偿机制
- 版本/环境展示

发行物：
- macOS Intel DMG（x64）
- macOS Apple Silicon DMG（arm64）
- Windows NSIS 安装包（x64）
- checksums.txt
- release-notes.md
- beta/latest.json

联调证据：
- 安装截图或录屏
- 登录成功日志
- 任务镜像创建记录
- heartbeat 记录
- 企业 Web 监控页面截图
```
