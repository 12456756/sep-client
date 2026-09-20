# 自动编排验证记录（2026-09-17）

## 验证边界

- 浏览器测试挂载真实 ArrangeWorkPage、WorkDetailPage 与 useEnterpriseWorkspace，只有 electronAPI 使用可控 fixture。
- 使用本机 Edge headless，分别验证 1200×800（普通动画）、960×640（减少动态效果）。检查选员、草稿、执行、完成阶段截图。
- **不是生产端到端验收**：未使用真实账号、平台接口或付费模型。产物 report.md 是 IPC fixture，不是模型实际生成的文件。
- 后端由 TaskRuntime / PiArrangementPlanner 自动化测试验证，worker 为测试替身；四个 PoC 单独检查 SDK 基础链路。

## 发现与修复

1. 编排计划及事件虽已加载，却未传入 buildWorkItem，导致执行详情误显示为对话、没有步骤进度。补齐接线和输入类型。
2. 完成后的进度条仍循环流动。复用已有 full 样式，在任务终态停止动画。
3. 真实节点完成事件只带 output、不带 title。保留开始事件中的标题，避免显示内部 node ID；修正文本清理正则误删英文 r/n。
4. typecheck 的根项目 files 为空，原命令漏检 renderer。显式检查 tsconfig.web.json 和 tsconfig.node.json。
5. 清理本次相关 hook 依赖警告及测试脚本 lint 错误；未修改无关现有 warning。

后端生产代码未在本轮修改。仅增强规划角色、首节点上下文、下游收到上游结果的测试断言。

## 固定上下文

- electron/domain/arrangement-planner.ts：buildArrangementPlannerPrompt 固定声明 SEP 自动编排 Agent，只能从 employeeCatalog 选员工，并返回合法 DAG。
- electron/runtime/pi-arrangement-planner.ts：将该提示词传给规划 worker。
- electron/runtime/arrangement-executor.ts：每个节点调用 buildArrangementNodePrompt 后传给 worker.run；包含总目标、当前节点、执行指令、预期输出和 PREREQUISITE OUTPUTS。
- 依赖结果按前置节点标题/ID 标注，首节点明确无前置结果；重试后下游测试断言收到 A recovered。

## 浏览器回归：8 场景 × 2 尺寸 = 16

- 创建草稿期间禁止重复提交。
- 完成事件早于 invoke 返回时仍能正确结束规划。
- 规划失败后显示错误并恢复可重试状态。
- 选员动画 → 草稿 → 确认 → 双员工执行 → 50% 进度 → 完成与产物；验证 reduced motion、进度条/圆环实际绘制与终态动画停止。
- 忽略旧 planningId 事件；取消后忽略迟到完成事件。
- 预检失败后的第二次确认使用新 revision。
- 启动期间禁止重复确认，未单独保存的步骤编辑仍带入计划。
- 确认返回 execution.id 后正确导航，并读取计划显示流程工作。

## 复跑

先在独立终端启动预览服务（不依赖 Electron 登录）：

```powershell
npx vite --config vite.preview.config.ts
```

再运行：

```powershell
node scripts/test-auto-arrange-ui.mjs
npm run typecheck
npm run lint
npm run test:tasks
npm run test:invariants
npm run check:boundaries
npm run build
npm run poc:01
npm run poc:02
npm run poc:03
npm run poc:04
```

默认预览端口为 5174，可用 SEP_PREVIEW_ORIGIN 覆盖。测试要求本机安装 Edge。
截图位于系统临时目录 sep-auto-{selecting,ready,executing,completed}-{1200,960}.png；失败时输出 DOM/工作模型诊断并保存失败截图。

## 最终检查结果

| 检查 | 结果 |
| --- | --- |
| 浏览器隔离测试 | 16/16 通过 |
| typecheck | 通过，包含 renderer |
| lint | 0 error，5 个现有 warning（WorkCanvas / WorkspaceComposer） |
| test:tasks | 263/263 通过 |
| test:invariants | 99/99 通过 |
| check:boundaries | 全部通过 |
| build | 通过，task-runtime 保持独立 chunk |
| poc:01–04 | 全部通过 |

未测量覆盖率百分比；以上不代表真实平台端到端验收完成。

## 尚需真实环境验收

使用真实账号，在 Electron 客户端提交目标，验证平台员工目录、实际模型选员、两名员工依次产出、真实工作目录文件落盘及审批行为。隔离测试不能代替这一步。
