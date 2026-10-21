# 语音输入系统权限适配

## 改动范围

- 新增 `electron/bootstrap/speech-system-access.ts`，主进程通过 `process.platform` 选择平台策略，以 `electron/domain/speech.ts` 中的接口注入语音服务。前端仍共用同一条录音和本地识别链路。
- Windows：检查 `systemPreferences.getMediaAccessStatus('microphone')`；系统允许后再完成应用首次确认，不调用 Mac 专用授权 API。
- macOS：首次未决定时通过 `askForMediaAccess('microphone')` 请求系统授权；已允许不重复询问，已拒绝或受限制时不循环弹窗。不再额外调用 Windows 使用的应用确认框。
- 每次录音前重新检查系统权限，应用内的已允许状态不能替代系统授权。系统拒绝不会抹掉原来的应用设置。
- 授权弹窗完成后需要再次点击或长按才录音。授权中松开、取消或切换页面不会因迟到结果而开始录音。
- 设置页新增“打开系统麦克风设置”。新增 IPC 无参数，只接受可信主窗口，系统链接由主进程固定，不接受前端传 URL。
- `package.json` 增加 Mac 麦克风用途说明，`build/entitlements.mac.plist` 增加音频输入权限；保持既有签名、公证、JIT 配置不变。
- 前端麦克风失败提示按平台区分，设备不存在和读取失败仍分别提示。

## 验证

- 按先测试后实现推进；新增测试先复现了系统权限未检查、Mac 声明缺失和错误提示固定为 Windows 等问题。
- 类型检查、生产构建、Lint、架构边界检查通过。Lint 仍有 WorkCanvas 与旧 WorkspaceComposer 的 5 条既有警告。
- 前端回归 246/246，任务并发及恢复回归 166/166；本轮未修改 Pi 加载与启动链路，因此未重跑四项 Pi POC。
- 后端语音专项 39/39 通过，包含系统适配、语音服务、设置 IPC、媒体权限边界、持久设置和推理运行时。覆盖已有授权、拒绝、限制、Windows 撤权、未知状态、异常、超时、固定设置地址，以及取消、关闭开关和退出登录后的迟到授权。
- 系统权限适配器与语音服务专项覆盖率：行 97.91%、分支 93.55%、函数 91.89%；适配器单文件三项均为 100%。这不是全项目覆盖率。
- Electron 端到端 12/12：虚拟麦克风下验证原识别、草稿、长按与输入法、取消、剪贴板和布局；新增 Windows 撤权阻断、错误提示保留、设置入口，以及模拟 macOS 接口的系统授权策略。
- Mac 麦克风打包声明专项 1/1 通过，检查用途说明、音频输入 entitlement 及其签名配置继承。本轮未重跑完整打包测试，也未生成安装包。
- 完整后端测试未全部通过：视频文件持久化相关测试出现 `EPERM: operation not permitted, fsync`，堆栈指向本轮未修改的 `electron/data/video-files.ts:100`。本轮不修改视频代码，也未对真实平台发起任务；不能宣称全项目无问题。

界面截图：`artifacts/sensevoice/client-tests/system-permission-settings.png`。

## 验证边界

- 当前开发机为 Windows x64。Mac 授权流程使用可控系统 API 替身验证，不代表已在 macOS 真实弹窗、签名包、Intel/Apple Silicon 原生库上通过验收。
- 自动测试不启用物理麦克风、不更改系统隐私开关、不真实打开系统设置；这些仍需人工验收。
- 本次只补权限流程与 Mac 权限声明，没有接入安装包内置模型或原生库解包。参见 `docs/对接/2026-10-20-offline-speech-packaging.md`。
- 本轮不执行 Git 提交或推送。

## 开发版启动

启动时 5173 已被占用，未关闭原服务。本分支以隔离配置启动，已确认后端装配、IPC 注册和页面加载正常。开发服务地址 `http://localhost:5174/`；需要在新打开的 Electron 窗口登录后测试语音，普通浏览器页面不具备 preload 能力。隔离配置位于忽略的 `artifacts/sensevoice/permission-dev-profile/`，不共用原客户端的账号和任务数据。启动入口为忽略的 `artifacts/sensevoice/permission-dev-bootstrap.cjs`。
