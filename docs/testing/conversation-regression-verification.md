# 对话式工作回归验证

## 范围与证据

本轮针对用户描述的首轮消息污染、流式显示、完成/取消状态和重复重试排查。未获取用户提到的原始截图，也没有该次运行的原始网关响应，因此不把本地回归结果等同于复现线上事故。

测试使用固定版本 pi-coding-agent 0.83.0、回环地址 HTTP 模拟网关，以及真实 React hook/对话抽屉配合受控 IPC fixture。没有请求真实企业平台，没有批准或执行真实 bash 工具，也没有批量改写用户历史任务。

## 已确认的断点与修复

| 问题 | 确认的原因 | 修复 |
| --- | --- | --- |
| 用户气泡出现工作目标和 JSON | 创建首轮对话时把内部工作元数据编码进了实际 prompt，历史消息展示没有剥离 | 新对话传原始用户目标；旧格式用户消息只展示目标；不改写普通后续消息和员工回复 |
| 流式回复消失 | 启动 RPC 返回后清空已到达的 delta；agent_end（包括即将重试）提前清空文本；完成后没有刷新历史 | 保留早到 delta；终态任务推送后读取持久化消息，成功后才清空 live buffer；防止旧请求覆盖新状态 |
| 完成仍为安排中 | ConversationExecutor 成功后返回 PENDING | 成功落 COMPLETED；继续对话仍复用原会话文件并开启新 run |
| 终止看似无效 | 取消最终落 PENDING；SDK 尚未创建时 abort 无法阻止后续 prompt；界面未等待结果 | 取消落 PAUSED（界面“已终止”）；取消可打断启动等待，迟到 session 释放；共享 session 清理排在下一轮打开之前；显示忙碌/失败状态并持久化原因 |
| 工具与重试反复出现 | 适配器把 tool_calls 和 role:tool 转为普通文本，丢失调用关联；SDK 默认上限只限制连续失败 | 保留 tool_calls/tool_call_id/role:tool；显式 session 重试配置、关闭 provider 层额外重试；每轮累计最多 3 次自动重试 |
| 重试活动一直转圈 | auto_retry_start/end 使用不同事件序号作为 activity ID | 按 runId 匹配重试活动并在成功/失败/预算耗尽后收尾 |

新增重试日志记录尝试次数、等待时间和脱敏错误；失败工具不再一律写成完成。

### 纵向路径

- 终止：WorkTalkDrawer / WorkRecordsPage → useEnterpriseWorkspace.stopWork → preload.cancelTask → TASK_CANCEL（Zod 验证）→ TaskService.cancel（scope/task 检查）→ TaskRuntime.cancelTask → PiTaskWorker.abort → SDK abort。
- 完成：SDK prompt / 事件落盘 → ConversationExecutor.finalize → runStore.finish → TaskManager.settleTaskRun → renderer bridge 任务推送 → hook 历史刷新 → 工作状态与消息显示。
- 流式：SDK message_update/text_delta → adapter → worker → runtime 事件持久化/推送 → hook 按 run 累积 → 对话气泡。

## 自动化验证结果

| 检查 | 结果 |
| --- | --- |
| npm run typecheck | 通过 |
| npm run lint | 通过；0 errors，5 条已有 warnings |
| npm run test:tasks | 273/273 通过 |
| npm run test:renderer | 21/21 通过 |
| npm run test:invariants | 99/99 通过（与 tasks 存在重叠，不相加） |
| npm run check:boundaries | 全部 enforced 规则通过 |
| npm run build | 通过，保留独立 task-runtime chunk |
| npm run poc:01 / 02 / 03 / 04 | 全部通过 |
| node scripts/test-conversation-ui.mjs | 1200×800 与 960×640 均通过；后者启用 reduced motion |

真实 SDK 模拟网关测试覆盖：

- 请求尚未结束时收到第一段文本；两段最终拼接正确。
- bash 授权被拒绝后，下一请求保留匹配的 tool_call_id 和 tool 角色。
- 401 单次请求后显式失败，无自动重试。
- 503 重试等待可立即取消；持续 503 在初始请求加 3 次重试后停止。
- 单元测试另外验证跨成功工具轮次的累计重试预算。

浏览器测试覆盖：原始用户气泡、启动返回前 delta、多段 delta、retrying agent_end 保留回复、完成后历史去重、旧初始化列表/历史请求不覆盖新推送、完成后继续对话、取消等待/错误/原因持久化、键盘焦点及抽屉边界。已查看渲染截图。复用仓库现有 WorkTalkDrawer 和确认控件，没有引入外部视觉组件或新依赖。

## 限制与后续真实平台复验

- 此次没有统计测试覆盖率，不能据此声称达到某个覆盖百分比。
- 时间线中的 Automatic retry started 本身不足以证明原始事故是 503、限流还是其他 provider 错误。工具协议丢失是已确认缺陷，但不是对每一次历史重试原因的证明。
- 本次验证不是运行中的 Electron 加真实平台联调；浏览器 IPC 使用 fixture，主进程和 SDK 链路由回归测试分别覆盖。
- 没有自动把旧的 PENDING 历史记录改为 COMPLETED，避免把真正待运行的工作误标完成。重新启动客户端后应新建一个短对话复验完成、继续、终止与错误轨迹。
- 中途重新挂载页面后的历史快照/流式增量边界尚未做完整断线重连测试。
- 仓库原有未提交改动保留。全仓 git diff --check 仍报告原有 platform-api.test.ts 文件末尾空行；本轮未修改该文件。
