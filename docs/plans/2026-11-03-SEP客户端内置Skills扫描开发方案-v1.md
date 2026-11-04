# SEP 客户端内置 Skills 扫描开发方案 v1

> 日期：2026-11-03。状态：开发设计，尚未实施。用户已确定：扫描功能直接内置 SEP 客户端；用户只安装或升级同一个客户端，不另下载、安装或登录独立连接器。
>
> 执行说明：按本文任务逐项开发和验收。本次交付为文档，不自动开始业务实现、提交、推送或部署。本文中的新文件、类型、IPC 和 HTTP 路径均为拟新增设计，不是当前已经可调用的接口。

**目标：** 用户在已部署的 SEP 网页点击“扫描本机”，由同一台电脑上的 SEP 客户端免业务登录地自动发现已授权 Agent 目录中的 Skills，在网页预览、选择后上传并创建待审核能力。

**架构：** Web 创建云端短期导入会话，通过系统协议唤起 SEP 客户端内置扫描模块。客户端主进程在本机扫描、生成快照，并主动通过 HTTPS 回传摘要、按需预览和选中包；Web 只访问 SEP 云端，沿用当前账号创建能力。客户端消费端会话、导入设备凭据与 Web 登录凭据相互独立。

**技术栈：** 现有 Electron、TypeScript、React、Zod、Node.js 文件系统/流/crypto、Electron safeStorage、现有 `fflate`/`js-yaml` 与 electron-builder；SEP 侧 NestJS、共享 Zod DTO、现有 Redis/Prisma 与包校验服务。首期不新增依赖、不升级 Pi SDK、不建立独立常驻服务。

关联文档：[SEP 全栈开发主方案](./2026-11-03-SEP本机Skills扫描导入全栈开发方案-v1.md)、[Web 前端详细方案](./2026-11-03-Skills本机扫描导入前端开发方案-v1.md)、[架构与账号复核](../research/2026-11-03-Web本机Skills扫描与开发者身份方案复核.md)、[扫描器与 Agent 目录核查](../research/2026-11-03-本地Agent-Skills扫描上传可行性调研.md)。完整交付需要 SEP 后端、Web 与本客户端共同实现；后端模块、数据模型、授权、上传与部署验收以全栈主方案为准。

**两份主文档：** SEP 全栈方案负责后端 + Web，本文负责桌面客户端，原前端方案为 UI 细节附件。2026-11-03 已对两份主文档进行纸面联调核对，结果与双方必须执行的联合验收矩阵统一保存在[全栈方案第 13 节](./2026-11-03-SEP本机Skills扫描导入全栈开发方案-v1.md#13-两份主文档联调核对记录)，不把文档一致性检查记作真实联调通过。

**对接进度：** SEP 后端、共享运行时 schema、Web 和部署配置已完成实现与定向验证，见[开发验收记录](../progress/2026-11-03-本机Skills扫描导入开发验收记录.md)。本文的桌面客户端实现与真实安装包验收仍待完成；接入时复用 `backend/src/shared/skill-import-schema.ts` 的字段、事件和错误码，不从页面示例猜测协议。

## 1. 产品与账号边界

### 1.1 交付形态

- 唯一面向用户的安装物仍是 SEP 客户端。Windows 使用现有 NSIS `.exe`，macOS 使用现有 `.dmg`。已有用户升级，未安装者下载安装同一产品，不提供第二个“扫描助手”安装包。
- 客户端新增“本机 Skills 导入”模式，可在登录前使用，也可在已有员工工作区内打开。它显示站点、网页发起者、设备确认、扫描范围、进度、取消和授权管理。
- 消费端继续使用现有企业登录、订阅、员工、任务和个人 Skill 版本流程。扫描模块不要求注册企业、购买员工、创建消费者账号，也不修改现有 `enterprise_missing` 校验。
- 当前首次创建 Skill 仍限定全局 `ADMIN`，最终上传归属由 Web 发起者决定。客户端即使已登录另一人，也不切换或借用该人的消费端 token。
- 首期一次导入一个 Skill，保留 Web ZIP 上传。不做批量创建、执行技能、自动发布、自动安装依赖或自动绑定员工。

### 1.2 明确能发现哪些文件

本机模块默认检查当前操作系统用户的预设 Agent Skills 目录。项目可位于任意磁盘，首次通过客户端原生目录选择器授权项目或代码工作区，后续复用。不是全盘扫描，不保证发现任意自定义安装、所有插件缓存、WSL、容器或远程主机目录。

“免登录”只表示扫描模式不要求客户端业务账号；本机程序仍需安装、站点/设备仍需首次授权，操作系统仍可能弹出文件访问提示。浏览器外部应用唤起提示也不能由 SEP 保证永远消失。

## 2. 当前代码基线

本节客户端路径均相对相邻仓库 `/Users/yao/LLM/sep-client`。本文保存在 SEP 的 `docs/plans/` 供两端共同评审，不把客户端源码搬入 SEP Web 仓库。

| 已有文件 | 当前行为 | 实施要求 |
|---|---|---|
| `electron/main.ts` | 兼容层、组合后端、路由、窗口、更新/停机；未发现系统唤起协议处理 | 新增早期单实例/深链接接收，保留首个 `undici-polyfill` 副作用导入和任务运行时惰性边界 |
| `electron/bootstrap/build-backend.ts` | 装配服务；`stopAll()` 被消费端登录/登出、失效和更新清理复用 | 装配无企业 scope 的扫描服务，区分业务停止与应用退出，不能把扫描永久关闭挂到消费端 `stopAll()` |
| `electron/bootstrap/main-window.ts` | 加载本地打包的 React 页面，隔离 preload；持有显示/导航配置 | 复用主窗口及现有导航限制，不能给远程 SEP 网页开启 Node 权限 |
| `electron/bootstrap/renderer-bridge.ts` | 唯一 `webContents.send` 出口，窗口重建可重新 attach | 增加扫描状态事件；渲染器恢复必须能主动读取当前快照，不能只靠一次事件 |
| `electron/controller/router.ts` | Zod 校验、错误信封，支持 `trustedMainFrame` | 扫描 IPC 必须检查可信主 frame，使用普通 `ipc` 错误信封，不触发消费端重新登录 |
| `electron/controller/channels.ts`、`routes/index.ts`、`electron/preload.ts` | 集中 IPC 通道与注册 | 增加窄 API，不导出 fs、shell、任意 HTTP 或 path 读取方法 |
| `src/App.tsx` | 无业务账号时进入 LoginPage，登录后进入 ClientAppPage | 在企业账号路由之前显示扫描界面；消费端状态保持，不能伪造登录成功 |
| `electron/controller/routes/auth.ts`、`common/platform/auth-session-manager.ts` | 均要求 enterprise；消费端凭据存在专用保险库 | 保持该规则；扫描设备凭据单独存储，不调用 `/client/auth/login` |
| `electron/service/skill-library-service.ts` | 对已授权能力保存个人版本 | 不复用其企业授权链路创建新 Skill |
| `electron/common/runtime-config.ts` | 从生成配置/环境解析 SEP 地址 | 扩展受信导入实例配置；禁止深链接覆盖 API base URL |
| `package.json`、`scripts/generate-builder-config.mjs` | 现有 DMG、NSIS、AppImage 与签名/更新渠道 | 注册导入系统协议、复用发布链，不另加安装器 |
| `electron/bootstrap/create-app-updater.ts`、`shutdown.ts` | 有界停机、安装前清理 | 将导入中的快照/上传纳入退出与更新协调，复用现有退出通道 |

核查时本地安装的 Electron 为 `33.4.11`，electron-builder 为 `25.1.8`（package 声明 `^25.1.7`）；未来实施先核对锁文件和已安装 API，不照抄最新版文档中本地版本没有的 API。现有 `main-window.ts` 为 `nodeIntegration: false`、`contextIsolation: true`，但 `sandbox: false`，本文不把它写成已经启用进程沙箱，也不借本任务改造全应用窗口安全配置。

SEP 当前官网发行配置在 [`web/src/config/client-releases.ts`](../../web/src/config/client-releases.ts)，核查时仍指向 `0.1.2`，客户端源码 package 版本为 `0.3.1`。两者只是当前源码记录，不能据此认定任何版本已包含扫描能力或线上已发布。交付时发布一个实际验收通过的新版本，再更新下载配置及支持协议版本。

## 3. 用户流程与状态

### 3.1 首次连接

1. Web ADMIN 在 Skills 导入区点击“扫描本机”，后端创建 `waiting-client` 会话。
2. 网页用用户点击触发系统协议。若创建 session 的异步请求之后浏览器不再保留用户激活，显示“打开 SEP 客户端”按钮，再由用户点击唤起。未安装时保留“下载 SEP 客户端”；无法确认唤起时提示“打开客户端后重试”，不能根据超时断言未安装，也不自动重复下载。
3. 客户端接收定位参数，验证受信实例和会话，打开“本机 Skills 导入”界面，显示从服务器取得的站点、发起者和本次用途。
4. 首次设备绑定：客户端显示短码和待扫描范围，用户点击“允许”；网页比对同一短码并确认本机设备。两端确认与设备密钥证明全部完成之前，不扫描、不回传候选、不签发包上传授权。
5. 获得短期导入授权后扫描已批准根目录。网页轮询得到候选，用户选择后请求预览与文件清单。
6. 用户点击网页“导入所选技能”，客户端校验预览快照，生成 ZIP，再为对应 operation 申请 upload grant 并受限上传。后端校验成功后返回已有包元数据。
7. 网页填写能力信息，调用现有 `POST /capabilities` 创建待审能力；客户端显示“文件已传送，请回网页完成创建”，不能显示“已发布”。

安装后首次启动可能只进入登录页。LoginPage 增加“本机 Skills 导入，无需登录”入口，允许回到等待网页唤起/授权管理界面；安装器不携带任务凭据。安装耗时导致原会话过期时，由网页重建会话并重新点击打开客户端。

### 3.2 后续使用

网页仍通过深链接定位**当前电脑**，已绑定客户端用设备密钥领取该会话。已批准的同一站点、Web 用户、操作系统用户和扫描范围可按已存授权生成本次 consent，前台展示上下文，不重复本机点击和 Web 短码确认；不允许后台无深链接扫描。扩展范围或身份改变，先结束旧会话，再新建会话并重新两端确认。

不能只按云端“最近在线设备”自动下发任务，否则用户在电脑 B 打开网页可能扫描电脑 A。网页先保留等待状态，由实际收到本次深链接的客户端证明身份并认领；已绑定设备不意味着允许云端随时后台读文件。

### 3.3 状态与计时

```text
waiting-client → pairing（首次）→ ready → scanning → results
                                                   ↓ 选择
                                               previewing → results
                                                   ↓ 确认导入
                                               packaging → uploading → uploaded

任一未终止阶段 → cancelled / expired / failed
```

`uploaded` 是文件导入终态，平台创建结果由网页现有表单管理。客户端本地另有 `idle`、`awaiting-local-consent`、`busy` 和可恢复错误状态，不混入服务端任务终态。

| 参数 | 首期约定 |
|---|---|
| 协议版本 | `protocolVersion: 1`，客户端实际版本单独返回；不以 package 版本替代协议兼容判断 |
| 配对/认领等待 | 5 分钟；配对短码限速、一次性使用；到期重建会话 |
| 会话空闲/绝对上限 | 无用户操作或实际新增工作进度 10 分钟过期，任务最多 30 分钟；心跳、轮询、grant 续期不刷新空闲计时 |
| Web/客户端轮询 | 活跃任务 2 秒；网络失败退避至最多 10 秒并加抖动，遵守 `Retry-After`；终态停止 |
| session 授权 | 最长 10 分钟且不超过会话截止时间，提前 60 秒重新挑战续期；不重新扫描、不延长会话 |
| 上传授权 | ZIP 完成后申请，最长 5 分钟且不超过任务剩余时间；只允许一次选定包成功；重试复用 operation ID、快照、同 ZIP 哈希及字节数 |
| 已开始上传的处理时限 | grant 有效时开始后，最多处理 5 分钟且不超过会话截止时间；owner/epoch/设备撤销仍立即约束结果提交 |
| 预览超时 | 60 秒；失败回 results 并失效旧快照，不自动把整个会话置 failed |
| 并发 | 每个客户端进程同时最多 1 个扫描/打包任务；重复深链接幂等，另一会话显示忙碌，不抢占原任务 |
| 自动恢复 | 不在客户端重启后自动扫描/续传；用户从 Web 重新唤起，再校验会话与文件快照 |

上述时间是产品/协议设计默认值，集中在共享契约，不散落硬编码。任务取消后须拒绝迟到事件，不能从 `cancelled` 又变为 `uploaded`。

首个 session grant 签发时，后端恰好入队一条 scan 命令；客户端 command-started 事件触发 scanning。后续续期/重复唤起/重复拉命令不重新扫描。网页“刷新”取消旧会话并创建新会话，不存在本期未定义的 rescan API。非终态 DELETE 转 cancelled；uploaded 后 DELETE 仅关闭授权、保留 uploaded 历史。

## 4. 分层与文件规划

### 4.1 客户端依赖方向

```text
本地 React 扫描界面
  → preload 窄 API → controller/skill-import 路由
  → service/SkillImportService（授权、状态、调度）
  → data/SkillImportFiles（发现、快照、ZIP）
  → common/platform/SkillImportApi（独立设备协议）

bootstrap 负责构造、原生选择器/加密适配器、深链接和生命周期
domain 定义端口与状态，不依赖 Electron 或业务登录
```

服务层不导入 `node:fs`/`node:path`、不拼磁盘路径、不导入 Pi SDK。文件操作在 data 层；系统目录选择在 controller/bootstrap；HTTP 适配器由组合根注入。扫描不调用模型，不加载 `task-runtime`，也不读取现有员工技能 scope。

### 4.2 拟新增客户端文件

| 路径 | 职责 |
|---|---|
| `src/shared/skill-import-contracts.ts` | 渲染进程可见状态、请求/结果、协议 schema；不含私钥或真实根目录映射 |
| `electron/domain/skill-import.ts` | 设备/会话/扫描端口、命令状态机与不变式 |
| `electron/common/skill-import-link.ts` | 深链接纯解析、参数上限和实例 ID 校验 |
| `electron/common/platform/skill-import-api.ts` | 固定受信 HTTPS 实例下的设备挑战、会话、事件、流式上传；独立于 AuthSessionManager |
| `electron/data/skill-import-device-store.ts` | 设备私钥加密持久化、站点/用户绑定与 root 授权；使用已有原子写模式 |
| `electron/data/skill-import-files.ts` | 根目录发现、候选、realpath 检查、受限预览、快照、流式 ZIP、临时文件回收 |
| `electron/service/skill-import-service.ts` | 会话认领、两端确认、扫描/上传编排、取消与幂等；依赖接口注入 |
| `electron/bootstrap/skill-import-deep-link.ts` | 单实例、冷/热启动 URL 队列和受控导航；不把外部 URL 原样交 renderer |
| `electron/bootstrap/create-skill-import.ts` | native 加密/选择器与各端口装配；复用现有组合根 |
| `electron/controller/routes/skill-import.ts` | 免业务登录的窄 IPC；每个入参 Zod 校验和可信 sender 检查 |
| `src/features/skill-import/use-skill-import.ts` | 本地 IPC 状态读取、订阅和取消；不请求平台管理员 HTTP 接口 |
| `src/pages/SkillImportPage.tsx` | 本地确认/进度/范围/撤销界面；Web 保留完整候选工作区 |

每个核心 `.ts` 模块配对应 `*.test.ts`。已存在的 `src/shared/ipc.ts`、`electron/preload.ts`、`controller/channels.ts`、`routes/index.ts`、`request-context.ts`、`bootstrap/build-backend.ts`、`renderer-bridge.ts`、`main.ts`、`src/App.tsx`、`src/pages/LoginPage.tsx`、打包/更新文件按后文任务修改。

`App.tsx` 中的扫描视图作为独立于账号恢复状态的本地 overlay/顶层视图状态管理，不能被 `restoringAuth`、记住密码读取错误或无企业账号阻塞。若工作区已经挂载，打开扫描层保留其组件与当前账号状态，不用卸载/重新登录实现模式切换；冷启动直接到扫描页也不能先等待员工目录或订阅接口成功。

### 4.3 扫描核心复用

以 SEP 的 [`scripts/skill-scanner/scanner.mjs`](../../scripts/skill-scanner/scanner.mjs)、[`zip.mjs`](../../scripts/skill-scanner/zip.mjs) 和 fixture 测试为迁移依据，在客户端 data 层形成受类型约束的实现；不能从打包客户端运行工作区绝对路径或 shell 调用 `sep-skill serve`。首期不为跨仓库复用新增 npm 包或依赖，也不将旧 CLI 入口直接导入启动路径。

迁移时把已确认的问题作为回归案例：共享 `.agents` 来源筛选、中文 ZIP 文件名、YAML 多行描述、父目录遍历边界、symlink 越界、候选变化、树哈希与 ZIP 哈希分离。SEP 中旧 CLI 保持历史工具状态，本次不顺带重构其发布入口。

## 5. 系统协议与启动

### 5.1 唯一协议格式

```text
sep-import://skills/v1?instanceId=<registered-instance-id>&sessionId=<opaque-session-id>
```

协议名为本需求拟定的新契约。`scheme=sep-import`、`host=skills`、`pathname=/v1`；只允许上述两个参数，均须非空、长度受限，拒绝重复参数、未知参数、userinfo、port、fragment、控制字符和超长输入。完整 URL 建议上限 2 KiB；ID 使用共享 schema，不接受路径、嵌套 URL 或命令。

`instanceId` 由客户端受信配置映射到固定 Web Origin/API base URL。默认使用随正式客户端发布的实例配置；企业私有部署由管理员配置或经本机显式添加 HTTPS 站点并核验后保存。不接受从深链接提供 `baseUrl`、回调地址或下载地址，不自动跟随跨实例重定向。

`sessionId` 只是任务定位信息；泄露或抢先提交它不能领取授权。URL 中不能携带 access/refresh token、上传授权、配对秘密或本机文件路径；日志不输出完整 URL。

### 5.2 冷启动、热启动与渲染器恢复

1. 保留 `main.ts` 首个兼容层导入，在异步 `whenReady()` 之前同步注册 macOS `open-url`，并建立有界待处理 URL 队列，防止启动早期丢事件。
2. 用 `requestSingleInstanceLock()` 管理同一用户数据目录的单实例；第二实例只递交经解析的导入请求后退出，不能再组装后端、启动扫描或覆盖设备保险库。
3. Windows 从首次 `process.argv` 与后续 `second-instance` 参数中查找严格匹配的协议项，不假设最后一个 argv 永远是 URL，不把命令行当 shell 执行。
4. 组合根、IPC 和窗口就绪后消费队列。renderer 通过 `getSkillImportState()` 取得当前状态，再订阅事件；不能依赖页面订阅前已经发出的单次事件。
5. 若客户端已有员工任务，只聚焦同一窗口中的扫描视图或独立的本地 overlay，保留企业账号和在跑任务；离开扫描视图可回工作区。首期不新增第二个带完整业务 preload 的窗口。
6. 重复唤起同一 session 聚焦当前视图；另一 session 返回忙碌并提示回网页重试，不自动取消当前任务。

Electron 的协议唤起需要系统注册和正确打包；macOS 的 Info.plist/系统关联与 Windows 安装后的注册必须用真实安装物验证，开发服务器测试不能替代。[官方依据见第 13 节 E1/E2]

## 6. 首次配对、设备凭据与 IPC

### 6.1 两端确认流程

1. 客户端生成独立的设备密钥对，提交公钥、客户端版本、协议版本和 session 定位 ID，后端创建待确认 pairing，绑定公钥指纹，生成短码和本次设备证明挑战。
2. 客户端与 Web 各从已验证的 SEP HTTPS API 获得同一短码、发起用户和配对 ID；客户端显示所请求根范围，用户确认本机授权；网页用户确认匹配的短码与设备。不能按“第一个连接者”自动批准，遇到指纹变化要废弃原 pairing。
3. 后端仅在当前 Web ADMIN 的确认、本机确认与设备私钥对服务器一次性挑战的签名全部成立后签发 session grant。短码仅供人比对，不是通用管理凭据，失败需限速。
4. 同一站点/用户已绑定设备，走设备挑战证明；先由本次深链接发起，再领取短期 grant。持久设备授权本身不能订阅任意用户任务、请求任意 path 或自行上传文件。

使用 Node `crypto` Ed25519，不自行实现密码算法。公钥为 SPKI DER 的无填充 base64url，指纹为其 DER 的 SHA-256 小写十六进制，签名为无填充 base64url。签名字节与 consentHash 的有序数组、字段编码严格采用[全栈方案 6.2 节](./2026-11-03-SEP本机Skills扫描导入全栈开发方案-v1.md#62-首次设备绑定)及其共享 fixture；签名覆盖 purpose、instance/session/pairing/device、nonce、期限及 rememberDevice/scope/rootIds 摘要，不能只签 nonce。

签名已有效但 Web 尚未确认时，`POST grants` 返回 202 pending-web-confirmation，不消费 nonce、不发授权；客户端每 2 秒重发同一证明直到确认或配对到期。双方满足后返回 200 并一次性消费 nonce。已消费返回 409 CHALLENGE_USED；若 200 响应丢失，通过 challenges 新 nonce 再证明换发，不重做双方确认、不重新入队 scan。返回字段为 sessionId、deviceId（临时配对为 null）、sessionGrant、sessionGrantExpiresAt、sessionExpiresAt、idleExpiresAt、acceptedScopeHash，客户端核对范围后才扫描。

### 6.2 存储与撤销

- 私钥留主进程，以 Electron safeStorage 加密后写独立数据目录；站点、Web 用户与设备 ID 联合隔离，同一电脑切换操作系统用户不能复用文件。
- session grant、upload grant 仅内存保存，不出现在 React props、IPC 返回、URL、命令行、日志或 localStorage。现有消费端 refresh token 完全不读取、不转交。
- 安全存储不可用时只允许经两端确认的本次内存配对，不保存设备密钥、不“记住设备”；重启需重新确认。不得退化成明文长期设备凭据。
- 后续 Linux 适配还需检查 `safeStorage.getSelectedStorageBackend()`，`basic_text` 不满足持久设备密钥保护要求；不能只凭接口名或 `isEncryptionAvailable()` 判断可保存。
- 本机“取消本次导入”和“撤销该站点/账号授权”不同。在线撤销通过 purpose=device-revoke 的挑战证明调用专用 revoke API，立即停止本机读取/上传，服务端确认撤销后删除私钥。离线时立刻停用绑定，只保留加密的待撤销记录及签名所需私钥，禁止再次用于扫描；联网完成撤销后删除。离线时云端尚未撤销必须明确显示，用户也可通过 Web 设备管理撤销；不能写成离线删除密钥后还能凭空同步签名。
- Web 登出/切换账号取消当前会话，服务端把 grant 绑定可验证的 Web 发起会话与权限；不要只依赖 `beforeunload`。服务端逐请求检查取消/吊销/当前角色，到期也会终止无人继续操作的会话。

Electron 33.4.11 的 safeStorage API 为同步方法，不从最新版文档照抄新的异步 API。safeStorage 保护落盘数据，并不能承诺抵御同一操作系统用户下所有恶意程序。[官方依据 E3]

### 6.3 最小 IPC

scope/rootIds 在本地界面回显后提交，主进程必须与当前会话请求和已授权根映射比较；拒绝 renderer 自报未知 rootId、绝对路径或扩大范围。签名使用这组已核准的 scope/rootIds，不能只签 pairingId/rememberDevice。acceptedScopeHash 按全栈方案算法复算后比较。

| 拟新增方法 | 输入 | 输出与限制 |
|---|---|---|
| `getSkillImportState()` | 无 | 安全视图快照，含版本/阶段/已批准根标签/配对显示信息；不含 grant |
| `confirmSkillImportConsent({ pairingId, rememberDevice, scope, rootIds })` | 配对 ID、是否保存授权、user/project/all 与已批准的不透明根 ID | 主进程复核当前 pairing、请求范围与本机授权根后签名；仍需后端确认 |
| `selectSkillImportRoot()` | 无 | 原生目录选择器选择后返回 root ID/本机展示信息；拒绝从 renderer 接收任意 path |
| `removeSkillImportRoot({ rootId })` | 已授权 root ID | 撤销范围；在途对应扫描失效 |
| `cancelSkillImport({ sessionId })` | 当前会话 ID | 幂等取消 |
| `revokeSkillImportDevice({ deviceId })` | 当前本机绑定的服务端设备 ID | 撤销指定站点/用户绑定，不与本地 rootId 混用 |
| `onSkillImportStateChanged(handler)` | 回调 | 返回 unsubscribe；仅 `renderer-bridge.ts` 发事件 |

通道名集中新增 `skill-import:*`，不修改旧通道字符串。所有 routes 使用 `{ trustedMainFrame: true, errorShape: 'ipc' }`，通过已有 router 校验 `event.sender` 和主 frame；不能使用消费端 `withAuth` 或把导入 401 映射为消费端登录失效。选择器与事件只对已装配本地渲染器开放。

## 7. 扫描、预览与打包规则

### 7.1 根目录与授权

目录适配表以[现有官方目录核查](../research/2026-11-03-本地Agent-Skills扫描上传可行性调研.md#agent-技能目录官方核查)为依据；在本机解析 home、XDG 和已支持工具配置，不能用服务器 home、进程 cwd 或 Web 输入当用户项目路径。共享来源允许多个 Agent 标签，选择 Codex 时不能漏 `.agents/skills`。

保存 root ID 与本机 realpath 映射；Web 只传 root ID/作用域，不能传绝对路径。默认个人路径一次确认，新增项目/自定义路径在本机选择并确认，不能把整个主目录自动变成授权范围。项目祖先发现最多到获准工作区/仓库边界，禁止一直追到文件系统根。

### 7.2 分阶段读取

| 阶段 | 读取与输出 | 防护 |
|---|---|---|
| 发现 | 在获准根中有限深度找 `SKILL.md`，读取入口大小上限内的名称/描述；返回摘要 | 跳过 `.git`、`node_modules`、缓存，逐目录错误隔离，可取消；默认候选遍历上限 5,000、深度 6，截断必须显示 |
| 预览 | 只读所选候选，生成完整相对文件清单、入口正文、treeHash 与 snapshot ID | 预览预算受包上限约束；按需分批；不发送绝对路径、未选择技能的正文或二进制附件 |
| 确认打包 | 网页确认 candidateId + snapshotId 后，核查文件集合/内容，复制或流式生成一致快照，再生成 ZIP | 内容或路径变化返回 `CANDIDATE_CHANGED`，重新预览；不能悄悄上传预览后新增的文件 |

入口 UTF-8 与 YAML 由既有 `js-yaml`/现行兼容规则解析。解析失败可报告预览警告，不能恢复已废弃的 ASCII-only 名称或最低正文长度限制；最终格式判断由服务端权威校验。

### 7.3 文件安全与资源限制

- 只识别以 `SKILL.md` 为入口的目录型包，保留必要 scripts/references/assets、许可证；不执行任何脚本、不访问外部依赖。不将 rules/commands 自动当技能。
- `lstat/realpath` 检查授权根与目标，拒绝设备文件、socket 等非普通文件。支持获准范围内的必要 symlink 目标复制为普通文件；跨根链接先本机追加授权，循环或不可安全解析时明确阻断。Windows junction、大小写和盘符边界单独测试。
- 不静默跳过被技能引用的必要资源。真实 `.env`、私钥或匹配凭据的文件阻断并只显示相对路径/原因；`.env.example` 不单凭名字一律拒绝。秘密原文不进云端摘要、日志或错误栈。
- 打包从确定的文件快照读取；访问前后检查真实路径、文件身份和内容。发生竞争、软链接替换或无法证明快照一致时失败，不声称仅凭 mtime 已排除所有 TOCTOU 风险。
- ZIP UTF-8 文件名、路径层级、CRC、中文文件名和空目录等必须与实际后端往返验证。`treeHash` 表示候选内容，不当作服务端 ZIP `sha256`；最终以服务端返回值为准。
- 权威预算来自 [`skill-content-schema.ts`](../../backend/src/shared/skill-content-schema.ts)：`SKILL.md` 2 MiB，ZIP 100 MiB，解包总量 500 MiB，最多 10,000 条目。候选清单 Web 每页 25，文件清单每页最多 100；纯摘要/文件清单分页响应最多 1 MiB。包含入口正文或上传结果 `content` 的响应上限 16 MiB，入口 UTF-8 原文仍最多 2 MiB，预留 JSON 最坏转义与元数据空间；不要把多个完整技能正文累积到同一轮询响应。
- 使用分块异步文件读取、流式 ZIP 和有界背压写临时文件/HTTP body，避免一次将 100 MiB ZIP 和 500 MiB目录读进主进程内存。复用已有 `fflate` streaming 或经测试的 ZIP 写入逻辑，不使用阻塞式整包同步压缩。打包前与写入中都检查预算。
- 快照与 ZIP 放 data 层管理的专用临时目录，操作 ID 随机、权限收紧；终态和应用启动时回收过期临时文件。不将源 Skill 复制到员工安装目录，不修改源文件。

预览正文经云端传到 Web，属于用户明确选择后的读取；绝对路径默认只在客户端展示，Web 使用“个人/Claude”等 root 标签与相对路径。云端会话数据短期保存，访问日志不记录正文和文件清单。

## 8. 与 SEP 云端的对接契约

### 8.1 身份与共享数据

所有新 API 相对 `/api`。Web 路由使用当前 JWT + ADMIN + 发起者归属校验；`connector` 命名空间是**客户端内置扫描模块的技术端点名**，不是要求安装独立软件。其使用独立设备/会话/上传 grant guard，不能用客户端业务 token 或放开现有管理员 guard。

服务端权威 schema 建议放 `backend/src/shared/skill-import-schema.ts` 并导出；客户端维护对应 Zod 边界与版本化 JSON fixture，跨仓库契约测试校验字段、限制和签名编码。不能只同步 TypeScript 类型而省略运行时验证。

```ts
type ImportSessionStatus =
  | 'waiting-client' | 'pairing' | 'ready' | 'scanning' | 'results'
  | 'previewing' | 'packaging' | 'uploading' | 'uploaded'
  | 'cancelled' | 'expired' | 'failed';

interface SkillImportCandidate {
  candidateId: string;                 // 会话内随机 ID，不是路径或凭据
  revision: number;
  name: string;
  description: string | null;
  sources: string[];
  scope: 'user' | 'project';
  locations: Array<{ rootId: string; rootLabel: string; relativePath: string }>;
  treeHash: string | null;             // 发现时可为空，预览后才确定
  availability: 'previewable' | 'blocked';
  warnings: Array<{ code: string; message: string; severity: 'warning' | 'blocking' }>;
}

interface SkillImportSelection {
  candidateId: string;
  snapshotId: string;                  // 已预览的确定文件集合
  operationId: string;                 // 打包与上传重试键，不等于创建幂等键
}
```

预览响应使用同一 `requestId`、`candidateId`、`snapshotId`、`expiresAt`、`content`、`treeHash`、`fileCount`、`totalUncompressedBytes`、`estimatedPackageBytes`、`files[{relativePath,bytes}]`、`nextFilesCursor:string|null` 和 `warnings`。files 始终是数组，后续页为 `{snapshotId,files,nextFilesCursor}`。`snapshotId` 是文件集合 ID，不是上传凭据；不要分别命名成 snapshotToken/snapshotId。正文任务默认 60 秒超时，快照有效期不超过本次会话。后端完整接收所选预览及全部文件页后才允许 selection，快速切换候选的旧 requestId 事件 ack 为 ignored，不覆盖新选择。

### 8.2 Web 使用的 API（SEP 侧已实现）

| 方法与路径 | 行为 |
|---|---|
| `GET /skill-import/config` | 当前 ADMIN + 活跃 WEB sid 读取 enabled/instanceId/protocolVersion/minClientVersion；关闭时仍可读取。客户端不能用它替代受信实例配置 |
| `POST /skill-import/sessions` | `{requestId,protocolVersion:1,scope:'user'|'project'|'all'}`，默认 user；创建当前用户会话，返回 ID、截止时间、协议要求与受限深链接 |
| `GET /skill-import/sessions/:id` | 本人会话状态、设备待确认信息、分批候选/按需预览/上传结果；大型清单分页或分片，不无限增长单响应 |
| `POST /skill-import/sessions/:id/confirm-device` | 当前 Web 发起者确认 pairingId、公钥指纹和匹配短码；不自动批准其他 claimant |
| `POST /skill-import/sessions/:id/preview` | `{requestId,candidateId,revision}`；请求预览，读取深度受本机授权约束 |
| `POST /skill-import/sessions/:id/selection` | 确认 candidate/snapshot/operation ID；队列产生唯一打包上传命令 |
| `DELETE /skill-import/sessions/:id` | 非终态幂等取消；uploaded 后只关闭授权，保留上传历史，迟到事件被拒绝 |
| `GET /skill-import/devices`、`DELETE /skill-import/devices/:deviceId` | 仅本人绑定状态与撤销；GET 使用 limit/cursor 分页并返回 items/nextCursor。在线不等于已安装探测或允许自动扫描 |

### 8.3 客户端内置模块 API（SEP 侧已实现，真实客户端待对接）

| 方法与路径 | 凭据与行为 |
|---|---|
| `POST /skill-import/connector/pairings` | 首次提交 requestId/sessionId、公钥与版本，幂等创建 pairing；返回 pairingId/短码/挑战及最少确认上下文，不发扫描授权 |
| `POST /skill-import/connector/challenges` | purpose=session-grant 时 sessionId + deviceId 或 pairingId；purpose=device-revoke 时仅 deviceId，领取一次性挑战 |
| `POST /skill-import/connector/grants` | 提交签名和 rememberDevice/scope/rootIds；202 等待 Web，200 换 session grant；已消费挑战 409，不重发旧 token |
| `GET /skill-import/connector/sessions/:id/commands?cursor=...` | session grant；拉取本会话序号命令，不提供全用户任务列表 |
| `POST /skill-import/connector/sessions/:id/events` | session grant；回传候选批次、预览、进度或错误，event ID/序号防重放 |
| `GET /skill-import/connector/sessions/:id/operations/:operationId` | session grant；查询上传状态/retryable/sha256/错误及期限，不返回正文或 grant |
| `POST /skill-import/connector/sessions/:id/operations/:operationId/upload-grant` | session grant；打包完成后提交 candidateId/snapshotId/packageSha256/packageBytes，签发 uploadGrant/expiresAt |
| `POST /skill-import/connector/sessions/:id/package` | 独立 upload grant，multipart `file`；operation 与快照绑定，重试不得覆盖另一包 |
| `DELETE /skill-import/connector/sessions/:id` | session grant；本机取消通知，即使通知失败也立即停止本地读取/上传 |
| `POST /skill-import/connector/devices/:deviceId/revoke` | 独立 device-revoke 挑战签名；撤销对应公钥绑定，不要求仍有活动导入会话 |

仅允许固定命令集合 `scan`、`preview`、`package-selected`、`cancel`；每条包含 sessionId、commandId、sequence、expiresAt 和受限 payload。scan 携带已批准 scope/rootIds，preview 携带 requestId/candidateId/revision，package-selected 携带 candidateId/snapshotId/operationId；命令中无 token。客户端记录 commandId 并用 started/completed 事件确认，收到 nextCursor 不等于命令已执行，重复拉取不重复执行；候选批次按 ID 去重。

ZIP 完成后才申请 upload grant，返回主进程内存，服务器只存 token hash。未知上传结果先 GET operations/:operationId：succeeded 完成、processing 等待、pending/retryable 才以同 ZIP 申请新 upload grant 后重传。新 grant 不改变 operation/snapshot/hash/大小，旧 grant 不启动新请求；已开始的 processing lease 不因换发被并发替代。session grant 提前 60 秒通过新挑战续期，GRANT_EXPIRED 可尝试一次恢复；SESSION_CANCELLED/SESSION_EXPIRED/DEVICE_REVOKED 等直接停止，不循环续期。

服务端包接收入口在新模块中调用现有 `SkillPackageService.store` 与 `PackageSecurityService.scanSkill`，返回当前字段 `zipPath/sha256/fileCount/totalSize/filename/content/suggested/warnings`，并绑定为本人会话的结果。Web 取结果后仍用 `POST /capabilities` 创建，ZIP 页签仍用现有 `POST /admin/capabilities/upload-skill`；两条路径共享校验服务，不共享不恰当的访问凭据。

### 8.4 服务端实施前提

operation 状态仅 pending/processing/succeeded/failed，retryable 是独立 boolean，不是第五种状态。pending 可继续，processing 等待，failed 仅 retryable=true 才允许同包重试，succeeded 不再申请上传授权。

错误响应统一为既有 statusCode/message/requestId/timestamp/path 加顶层 code、可选 retryable。客户端从顶层 code 决定续期/取消，不解析中文 message。SEP 必须修改现有 `HttpExceptionFilter`，仅在 skill-import 路径保留共享错误码白名单，否则现有普通路由信封会丢弃 GRANT_EXPIRED/SESSION_CANCELLED，客户端恢复逻辑无法工作；需真实 HTTP 测试覆盖。

本节是客户端对接前提，不能代替后端开发文档。完整模块划分、数据模型、原子状态、鉴权、HTTP 预算与任务清单见[SEP 全栈开发主方案](./2026-11-03-SEP本机Skills扫描导入全栈开发方案-v1.md)。客户端每次命令/事件/上传都需通过服务端对发起者有效 WEB sid、当前 ADMIN 及设备撤销的复核，不能只凭 grant 尚未过期继续任务。uploaded 结果必须由服务端实际包校验产生，客户端不能通过事件自行声明导入成功。安全存储不可用时 consent 使用 `rememberDevice:false`，双方只保留本次内存/短期配对，不建立可复用设备绑定。

建议新增 `backend/src/modules/skill-import/`：Web controller、connector controller、service、设备/会话授权 guard，注册 `app.module.ts`；controller 只处理 HTTP/Swagger，入参共享 Zod DTO，逻辑在 service。不另建独立 Gateway。

现有 [`json-body.middleware.ts`](../../backend/src/common/middleware/json-body.middleware.ts)对普通 JSON 默认限制 2 MiB，Skill 专用分支为 16 MiB，但目前不匹配新 `/skill-import/connector/.../events`。含入口正文的预览事件需要在该中间件中新增精确路由分支并补测试，不能只写 DTO 上限、扩大整个站点 JSON 限制，或让 2 MiB 原文经转义后在到达 controller 前被拒绝。multipart 包入口使用独立文件预算；同时核对部署代理的该路径请求体预算和上传超时，文件上限与整个 multipart 请求体上限不能混为一谈。

短期会话/配对 nonce/命令序列可用现有 Redis 原子操作与 TTL，禁止仅存某个 Node 进程内存导致重启/多副本越权。持久设备绑定由 PrismaService 管理，只有公钥/指纹、站点用户关系、授权范围摘要与撤销状态落库；不存客户端私钥。实现时若增模型，遵循 cuid、表名映射及标准 Prisma migration/generate，不手改历史迁移。

创建、认领、回传、取预览、上传和最终创建都检查角色与归属。包上传成功但创建失败时保留网页已取得元数据；`POST /capabilities` 超时属于结果未知，当前未证实有创建幂等支持，禁止自动重发。取消/失败的内容寻址包不可直接随意删除，清理沿用现有存储生命周期并核对引用。

## 9. 生命周期与错误恢复

| 情况 | 客户端行为 | Web 行为 |
|---|---|---|
| 无企业账号/客户端未登录 | 正常进入扫描模式 | 沿用 ADMIN Web 身份 |
| 客户端已登录 B，网页为 A | 保留 B 的工作区，仅显示 A 发起的导入上下文 | 结果和创建归属 A；A 未绑定时重新确认 |
| 客户端消费端登录/退出/401 | 不删除导入设备凭据、不借用业务 token；两条状态互不改写 | 当前 Web 会话继续独立授权 |
| Web 退出/换账号或角色被撤销 | 后端拒绝 grant，取消扫描/上传并清理内存 | 清空对应用户 query/cache/选择；不接收迟到响应 |
| 未安装或唤起被拒绝 | 无扫描副作用 | 保留打开客户端/下载入口，不能宣称已扫描 |
| 协议版本过低 | 返回明确版本不兼容；允许进入升级指引，无业务登录前提 | 显示升级 SEP 客户端并保留 ZIP |
| 根目录权限不足/目录不存在 | 按根报告错误，其余范围继续 | 显示部分成功/未找到，不要求知道隐藏目录才能恢复 |
| 预览后文件变化 | `CANDIDATE_CHANGED`，丢弃待上传快照 | 要求重新预览确认，不能自动上传新内容 |
| 网络断开/429 | 有界退避，取消可立即停止，终态不自动重启 | 保留已授权候选，显示重试和到期时间 |
| 上传中连接断开 | GET connector operation 状态；processing 等待，仅 retryable 用同 ZIP 重领授权重传 | 不重复触发创建；显示上传与创建是两个阶段 |
| 用户关闭窗口 | 首期取消当前导入，停止轮询、释放快照；不隐式转为后台扫描 | 标记客户端离线/取消，允许重新唤起 |
| macOS 应用仍留在 Dock | 关闭窗口后的模块保持 idle，不持续云端任务订阅 | 下次由明确点击重新开始 |
| 客户端退出或更新安装 | 通过有界退出流程先取消导入和 HTTP，再清理临时文件；不自动恢复扫描 | 新进程重新唤起认领，已上传结果由服务器核对 |

现有 `stopAll()` 被消费端 auth 路由调用，不应直接新增永久销毁扫描 service。提供独立 `skillImport.cancelActive()`/`dispose()`，应用退出和更新组合调用；消费端登录/退出仍只清理其业务链路。更新器的“没有在跑任务”检查必须包含扫描/打包/上传或先明确取消，再安装；不能因消费端 taskStats 为零就中断正在传包。

日志经现有 logger/redact，只记录版本、阶段、错误码、匿名操作标识和耗时，不记录完整深链接、token、短码、用户名路径、正文或文件内容。导入协议 401 只失效导入 grant，不驱动消费端 `AUTH_REQUIRED`。

取消使服务端 grant 立即失效，不能依赖随后再拉到 cancel 命令。命令轮询返回 410/SESSION_CANCELLED、当前 owner/设备撤销或会话到期时主动终止；断网期间本地 deadline 到达也必须停止读取/上传，不只停止 HTTP 重试。

## 10. 安装、升级与发布

### 10.1 同一客户端安装包

在 `package.json` 的现有 `build` 配置新增系统协议元数据，示例仅为补充项，不覆盖现有 icon/签名/资源配置：

```json
{
  "protocols": [
    { "name": "SEP Skills Import", "schemes": ["sep-import"] }
  ]
}
```

`scripts/generate-builder-config.mjs` 继续 clone 现有配置，新增测试确保正式/本地生成配置均保留 protocols。打包元数据与运行时协议处理共同验收；不能用 `protocol.registerSchemesAsPrivileged('sep-result')` 代替系统唤起关联，这两个协议用途不同。[依据 E1/E2]

| 平台 | 用户安装步骤 | 首期验证 |
|---|---|---|
| Windows x64 | 下载同一 SEP `.exe`，完成 NSIS 安装；已有用户升级 | 冷/热启动、系统协议参数正确引用、普通权限、路径含空格、卸载后无悬挂关联 |
| macOS arm64/x64 | 打开 `.dmg`，拖入 Applications，首次启动后回网页点击扫描 | 正式应用包与 Info.plist 注册、签名身份/公证、冷/热 `open-url`、Keychain、升级后授权可读 |
| Linux | 当前已有 AppImage 配置 | 本期不承诺导入唤起可用；另验 desktop scheme 注册、安全存储与文件权限后再开放 |

不要求用户安装 Node.js、不运行命令、不装第二个软件、不要求管理员关闭系统防护。客户端只在显式唤起/授权时扫描；首期不新增开机启动、系统服务或后台 daemon。

### 10.2 版本与更新门禁

新能力必须有独立 `protocolVersion` 和最低受支持客户端版本，具体最低版本在实现完成后确定，本文不把当前版本标记成可用。Web 下载入口复用统一客户端发行配置，不硬编码另一份安装地址；mac 芯片保留用户可选项，不能凭浏览器 UA 绝对判定 CPU。

旧客户端可能不认识协议，网页只看到“等待客户端”；此时同时提供升级入口。新客户端必须能在扫描模式显示版本/下载指引，不把更新入口锁在企业登录之后。复用已签名版本的更新渠道；未签名本地包仅供开发验证，不作为面向用户的正式安装物。

发布先部署默认关闭的后端会话能力，再发正式客户端并验收，最后开放 Web 扫描入口。回滚时关闭 Web 扫描/新会话创建，已有客户端返回明确不可用并停止新任务，ZIP 入口仍可用；不删除用户源文件和已有审核记录。发布生产更新另按项目既有授权流程执行。

## 11. 实施任务与验证步骤

以下任务是实施顺序；每项先建立关键失败案例，再做最小实现并运行对应检查。本文不要求自动提交；仅在用户明确要求时提交。

### Task 1：冻结跨仓库契约与 fixture

**文件：** SEP 新建 `backend/src/shared/skill-import-schema.ts`、`backend/src/shared/skill-import-schema.spec.ts`；客户端新建 `src/shared/skill-import-contracts.ts`、`src/shared/skill-import-contracts.test.ts`、`electron/domain/skill-import.ts` 与固定 JSON fixture。

1. 将第 3/5/6/8 节字段、状态、边界、命令序号和签名消息格式落为 schema 与正反 fixture。
2. 为未知字段、超长 ID、越权候选、过期指令、重复参数和响应超预算建立失败断言。
3. 两端跑契约单测，确认正常 fixture 可解析，非法输入被拒绝；没有真实接口前只标注 mock 可用。

### Task 2：后端导入会话、配对和受限包接收

**文件：** SEP 具体按全栈方案 Tasks 1–6 实施：新建 `backend/src/modules/skill-import/`、共享 schema 与测试；修改 app.module、main 的解析前保护、JSON 预算、异常过滤器及 Skill 创建的活跃会话检查；使用工具生成设备模型迁移。不能只实现 controller 就视为客户端依赖就绪。

1. 测试两端确认前不能扫描/上传、sessionId 不能当授权、跨用户访问被拒绝、角色撤销和 nonce 重放、TTL 与多实例原子认领。
2. 实现会话命令/事件幂等和独立上传 guard，复用包/安全校验服务；不要修改 ADMIN 上传 guard 放行设备凭据。
3. 测试 operation 查询、打包后上传授权、同 ZIP 重试、不同快照冲突、取消后迟到结果、事件 JSON 转义预算与真实错误码信封；返回 artifact 与原表单一致，其他路由原有预算不变。

### Task 3：设备存储与深链接

**文件：** 客户端新增 link/device-store/deep-link 模块及测试；修改 `main.ts` 的同步启动挂接。

1. 先测冷启动队列、热启动、重复 session、并发第二会话、危险 URL/参数、未登记实例、密钥不可用与私钥不出 IPC。
2. 实现单实例、受限 URL 解析与安全存储；明确本次内存授权和持久绑定的区别。
3. 测试消费端已有账号不会被导入唤起覆盖，第二进程不创建第二套 service。

### Task 4：文件发现、预览和 ZIP

**文件：** 客户端新增 `electron/data/skill-import-files.ts` 与 `skill-import-files.test.ts`，迁移 SEP fixture 用例。

1. 建立临时目录 fixture：共享目录、同名不同内容、中文名、YAML 多行、权限错误、根不存在、链接循环/跨根、文件竞争、秘密与资源引用。
2. 分阶段实现扫描、预览、快照和流式打包，验证截断、预算、取消、进度与清理；不接模型或 Pi 运行时。
3. ZIP 用真实后端包服务解析验证内容与哈希；单测不扫描开发者真实 home、不连接真实数据库。

### Task 5：HTTP 编排、命令幂等与生命周期

**文件：** 客户端新增 `common/platform/skill-import-api.ts`、`service/skill-import-service.ts` 与测试；修改组合根、退出与 updater 组合适配。

1. 使用注入时钟/HTTP/文件端口模拟两端确认、命令重复、候选变化、网络中断、会话到期/取消和上传成功但响应丢失。
2. 实现轮询与短期授权，所有异步回调检查当前 session/revision，不让旧任务更新新任务。
3. 验证业务登出不调用导入 dispose、应用退出/更新才清理导入；入站/出站均不使用业务 token，不产生 localhost 服务。

### Task 6：IPC 与免登录界面

**文件：** 客户端新增 `controller/routes/skill-import.ts`、hook、`SkillImportPage.tsx` 及对应测试；修改 channels/router table/context/preload/共享 IPC/renderer bridge/`App.tsx`/LoginPage。

1. 先测无企业账号可进入扫描、主 frame 外调用被拒绝、密钥不在状态快照、状态恢复不丢事件、取消/撤销/根选择器交互。
2. App 顶层按本地扫描视图切换，保留消费端组件状态；不创建假的 AuthState，不把扫描失败导向登录。
3. 做实际 Electron 页面检查：首次配对、已绑定、忙碌、部分目录失败、过期、未授权和切回在跑工作区；视觉验收保留截图。

### Task 7：打包、协议、升级与 Web 联调

**文件：** 客户端修改 `package.json`、`scripts/generate-builder-config.mjs`、`scripts/packaging.test.mjs`、相关 release/update 测试；SEP 修改前端方案列出的组件/hooks 和正式发行配置。

1. 先测生成配置保留协议与原签名/资源选项，未登录扫描能访问升级指引，版本不足返回稳定错误。
2. 构建本机测试安装物，真实安装并用浏览器冷/热唤起；Win/mac 三种目标分别验收，不能把 mac 开发命令通过记作 Windows 通过。
3. 在测试 HTTPS 域名进行真实包导入，检查浏览器无 loopback 请求、Web A/客户端 B 隔离、服务端包校验和待审创建；签名正式安装物按现有发布渠道另验。

### Task 8：收尾与交付记录

**文件：** 两仓库对应 docs/progress 或验证报告、发行说明、本文交付状态。

1. 写入实际版本、操作系统/浏览器矩阵、各检查结果、失败恢复截图和未验证项。
2. 核查不包含私钥、真实 home 内容、`.env` 或本地安装物进 Git；同步前端/后端/客户端协议 fixture。
3. 只有在真实扫描到创建待审链路通过后才标记完成；上传成功、mock 或编译通过不能替代端到端证据。

### 11.1 实施阶段的命令

以下命令待相关文件实现后执行。它们是验证计划，本次文档工作未执行这些业务检查。

```bash
# 在 SEP 仓库：新模块与现有权限/包链路回归
pnpm --dir backend exec jest --runInBand src/modules/skill-import
pnpm --dir backend exec jest --runInBand src/modules/capability-contribution/capability-contribution.service.spec.ts src/modules/capability/capability.write-security.spec.ts

# 在 sep-client 仓库：核心文件和 IPC/启动回归
npx tsx --test electron/common/skill-import-link.test.ts electron/data/skill-import-device-store.test.ts electron/data/skill-import-files.test.ts electron/service/skill-import-service.test.ts electron/common/platform/skill-import-api.test.ts electron/bootstrap/skill-import-deep-link.test.ts
npm run test:tasks
npm run test:renderer
npm run check:boundaries
npm run typecheck
npm run lint
npm run build
npm run poc:01
npm run poc:02
npm run poc:03
npm run poc:04
npm run test:invariants
npm run test:packaging
npm run test:updates:runtime
```

新建的 renderer/IPC/契约测试必须显式加入现有 `package.json` 测试 glob，不能创建文件后假设测试脚本自动包含。由于本功能修改 `main.ts`/启动路径，客户端 AGENTS 要求四个 POC、typecheck/build；涉及 IPC 和并发/停机，还要做边界及 invariants 检查。任何未运行、失败或被环境阻塞的检查逐项报告，不写成通过。

## 12. 验收清单与工期口径

### 12.1 必须满足

1. 用户只安装/升级 SEP 客户端，不存在第二安装物或客户端业务登录步骤；Web ADMIN 无企业归属也可导入。
2. 同一电脑网页点击即可唤起当前本机，首次双向确认，后续已授权范围少操作；不默默扫描另一在线设备。
3. 正式 HTTPS 页面只请求云端，客户端主动 HTTPS；无本地 HTTP server、端口扫描或浏览器文件权限假设。
4. 支持至少 Claude、Codex、OpenCode、Gemini 的确定目录 fixture；共享目录、多来源、中文/YAML、项目范围与 symlink 行为可解释。
5. 深链接无凭据；跨账号/实例、抢领、签名重放、角色撤销、路径越界及取消后迟到回传均被拒绝。
6. 预览确定文件集合，变更后重新确认；只上传选中包，不修改/执行源文件；秘密不进日志或云端预览。
7. 上传返回原包元数据；最终仍由 Web 创建并待平台审核；结果未知不自动重建，不把导入显示为发布。
8. 关闭窗口、断网、退出、升级和崩溃后资源有界回收，工作区任务与业务登录无回归。
9. Windows x64、macOS arm64/x64 正式安装物完成冷/热启动和升级实测；未测系统明确不开放扫描入口。

### 12.2 估算

以单工程师、两仓库可修改、现有依赖与签名发布渠道可用为前提，先交付单机内测闭环，再扩充正式安装矩阵。以下为工程估算，非交期承诺：

| 工作 | 估算工程日 |
|---|---|
| 云端会话、设备配对/授权、受限上传与回归 | 3–4 |
| 客户端目录/快照/ZIP 修正与测试 | 2–3 |
| 客户端启动/免登录界面/IPC/退出更新 | 2–3 |
| Web 导入工作区和现有表单联调 | 3–4 |
| Win/mac 安装签名、跨端异常与最终验收 | 2–4 |
| **整体** | **约 12–18 工程日；独立部分可并行，证书/发版排期另计** |

首次调研的“Node 助手 + localhost 内测 5–8 日”不适用于本次内置客户端、云端配对和正式安装的完整范围。批量、Linux、WSL/容器、外部开发者权限开放均另计。

## 13. 证据与本次交付状态

外部能力依据仅使用官方文档或已安装包的类型定义：

- E1：[Electron 33.4.11 Deep Links](https://github.com/electron/electron/blob/v33.4.11/docs/tutorial/launch-app-from-url-in-another-app.md)：单实例事件、macOS open-url、打包注册要求。
- E2：[electron-builder 配置文档](https://www.electron.build/docs/configuration/)与本地 `app-builder-lib@25.1.8/out/options/PlatformSpecificBuildOptions.d.ts` 的 `protocols/Protocol`：当前安装版本确有协议元数据；完整安装/卸载仍需实测。
- E3：[Electron 33.4.11 safeStorage](https://github.com/electron/electron/blob/v33.4.11/docs/api/safe-storage.md)：OS 加密与 Linux basic_text 边界；本文没有引用更高版本的新 API。
- E4：[Electron 33.4.11 Security](https://github.com/electron/electron/blob/v33.4.11/docs/tutorial/security.md)：隔离远程内容、可信 IPC sender 与 HTTPS 要求。
- 账号与权限证据见[架构复核](../research/2026-11-03-Web本机Skills扫描与开发者身份方案复核.md#sep-当前账号与客户端的实际证据)，目录与扫描原型差距见[首次调研](../research/2026-11-03-本地Agent-Skills扫描上传可行性调研.md)。

本次完成开发文档及关联文档修订，核查客户端现有入口/分层/打包/更新、SEP 权限与发行配置，并检查文档本地链接、代码围栏与空白。未改业务代码、未安装依赖、未运行客户端、未产生安装物、未执行新接口/扫描/上传或跨系统验收。所有拟议任务均待开发，不以旧扫描器的测试结果声明本方案已完成。
