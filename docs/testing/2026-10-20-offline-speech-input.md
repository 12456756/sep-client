# 离线语音输入接入与回归记录

日期：2026-10-20。验证环境：Windows x64、Electron 33.4.11、CPU。

## 本次范围

- 新建对话、已有工作对话、自动编排目标、手动编排目标、员工详情输入框，共用同一套语音输入链路。
- 点击麦克风开始，再次点击停止；输入框聚焦后长按空格 400ms 开始，松开结束。普通短按空格、输入法选词、组合快捷键保持原用途。
- 识别结果只插入当前草稿的光标或选区位置，不自动发送或创建任务，支持撤销。
- 应用首次询问授权并持久保存，之后不重复询问；个人设置可关闭或重新授权。首次授权本身不开始录音，需要再次点击或长按。Windows 系统麦克风权限仍须允许。
- 同时仅允许一个输入框录音。取消、切换工作、失焦、退出登录或窗口关闭均终止当前操作，迟到结果不写入其他草稿。
- 单次最长 30 秒，结束后识别。无后台监听、实时逐字输出、云端兜底或运行时模型下载。

## 数据链路与主要文件

| 层次 | 文件 | 职责 |
| --- | --- | --- |
| 输入框接入 | `src/components/enterprise/arrange/{ChatArrange,GoalComposer,ManualArrange}.tsx`、`WorkTalkDrawer.tsx`、`src/pages/enterprise/EmployeeDetailPage.tsx` | 麦克风入口、发送禁用、原有输入交互 |
| 统一交互 | `src/features/speech/use-speech-input.ts`、`space-hold.ts`、`speech-controller.ts` | 长按、草稿插入、取消、超时、排他 |
| 录音 | `src/features/speech/browser-capture.ts`、`capture-worklet.js` | getUserMedia、实际采样率、单声道 Float32 PCM、尾帧校验与释放设备 |
| 共享契约 | `src/shared/speech-contracts.ts`、`speech-audio.ts` | Zod 校验、长度/采样率/数值边界、分块顺序、重采样辅助 |
| IPC | `electron/controller/routes/speech.ts`、`router.ts`、`channels.ts`、`electron/preload.ts`、`src/shared/ipc.ts` | 可信主窗口校验、有限 API、统一响应 |
| 授权与业务 | `electron/service/speech-service.ts`、`electron/data/speech-settings-store.ts`、`electron/domain/speech.ts` | 登录范围、持久授权、录音令牌、撤权与取消 |
| 进程与模型 | `electron/bootstrap/create-speech-runtime.ts`、`electron/runtime/speech-{runtime,worker}.ts`、`electron/data/speech-assets.ts` | 懒加载独立 utilityProcess、固定资源与哈希、CPU 推理、空闲释放 |
| 窗口与启动 | `electron/bootstrap/speech-permissions.ts`、`main-window.ts`、`build-backend.ts`、`electron/main.ts`、`electron.vite.config.ts` | 仅录音期间放行音频、拒绝摄像头、保留剪贴板写入、独立 worker 构建 |
| 界面 | `src/components/speech/`、`src/styles/speech.css`、`ProfileSettingsDialog.tsx` | 图标、状态、错误反馈、语音开关 |

PCM 在内存中通过受限 IPC 进入独立进程，经 sherpa 原生低通重采样到 16kHz，再交给 SenseVoice INT8。校验录音尾帧，避免直接丢弃最后一段；仅对重采样过冲做整体衰减，不自动放大低音量。音频、识别文本不主动写盘或写日志。

运行时使用既有 `sherpa-onnx-node@1.13.8`。Pi 版本不变，未改动任务执行、编排恢复或模型网关算法；保留 Pi 动态导入边界。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过，单独生成 `out/main/speech-worker.js` |
| `npm run lint` | 0 错误；5 条既有警告，位于 WorkCanvas 与旧 WorkspaceComposer |
| `npm run check:boundaries` | 全部 enforced 规则通过 |
| `npm run test:renderer` | 200/200 通过 |
| `npm run test:invariants` | 142/142 通过 |
| `npm run poc:01` 至 `poc:04` | 全部通过，使用本地测试网关 |
| `npm run test:speech` | 57/57 通过 |
| `npm run test:speech:electron` | 5/5 通过 |
| `npm run test:speech:record` | 13/13 通过 |
| `npm run test:speech:client` | 9/9 通过，使用生产组件、服务、IPC、preload 和构建后的真实识别 worker |
| 完整后端套件 | 1267/1290 通过，23 项失败均能在修改前 HEAD 基线上复现，没有新增失败用例 |

完整后端使用与 `test:tasks` 相同的文件范围，并启用 JUnit 输出。结果：`artifacts/sensevoice/backend-regression.xml`；基线：`artifacts/sensevoice/baseline-backend.xml`。基线有 24 项失败，其中额外一项由临时源码归档缺少 Git 上下文触发，不算本次修复。

既有失败主要是 Windows 下符号链接/重命名权限与路径长度，以及 `arrangement-delivery.test.ts` 中“终态失败后不启动并行兄弟节点”的断言。未修改这些无关模块。

Electron 测试仅使用虚拟麦克风和官方公开录音，不开启用户物理麦克风。覆盖：首次授权、拒绝未预约录音/摄像头、空格与输入法、草稿与撤销、真实推理、长按松开、取消与上下文切换、五个入口与互斥、撤权重授权、剪贴板复制，以及 960/1200 宽度布局。截图位于 `artifacts/sensevoice/client-tests/`。

## 尚未完成与风险

- 尚未改安装包：当前开发版使用 `resources/speech/sensevoice-int8/` 中的本地模型和词表。正式发布前仍需配置资源内置、原生库解包、缺失资源构建拦截，并在干净 Windows 机器断网验证安装包。
- 模型约 228 MiB，其 FunASR 模型许可与运行时 Apache-2.0 不同，商用分发须单独确认并保留声明；不把测试 WAV 直接作为生产资源发布。
- 未验证 macOS/Linux、复杂噪声或业务术语准确率；自动测试不能代替真实麦克风与人工标注录音测试。
- 本次未对真实平台发起新任务或重试操作；不能据此宣称所有平台联调场景均已验证。
- Git 提交与推送按用户指令另行执行，不属于功能测试结果。

## 合并远端后的复测

语音提交 `b61eca7` 与远端 `ed69857` 合并时，保留两侧新增的服务、IPC、preload 声明和忽略规则。远端更新主要为视频生成与原输出恢复功能。

- 类型检查、生产构建、架构边界检查和四项 Pi POC 全部通过。
- 前端测试 229/229，任务回归 166/166，语音及视频 IPC 专项 31/31，语音 Electron 端到端 9/9 全部通过。
- Lint 仍为 0 错误、5 条既有警告。
- 合并后未重跑完整后端套件；上文 1290 项及基线对照是合并前的记录，不代表远端新增全部后端测试均已验证。
- 模型安装包接入仍未完成，平台方打包事项见 `docs/对接/2026-10-20-offline-speech-packaging.md`。
