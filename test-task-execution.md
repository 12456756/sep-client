# 任务执行测试指南

## 方法 1：通过 UI 创建任务

1. 点击右上角 **"➕ 新建任务"** 按钮
2. 填写表单：
   - **任务标题**：测试文件创建
   - **任务描述**：创建一个 hello.js 文件，内容是 console.log('Hello from SEP!')
   - **工作目录**：点击"浏览..."，选择 `/tmp` 或桌面
3. 点击 **"创建任务"**
4. 任务会自动开始执行，你会看到：
   - 任务卡片从"待执行"列移动到"执行中"列
   - 卡片上显示旋转的加载动画
   - 点击卡片可以在右侧抽屉查看实时日志

## 方法 2：通过浏览器控制台测试

打开开发者工具（Cmd+Option+I），在 Console 中执行：

```javascript
// 1. 创建测试任务
const result = await window.electronAPI.createTask({
  title: '测试任务：创建 hello 文件',
  prompt: '在工作目录下创建一个 hello.js 文件，内容是 console.log("Hello from SEP!")',
  workDir: '/tmp/sep-test'
});

console.log('任务已创建:', result);

// 2. 执行任务
if (result.success && result.task) {
  console.log('开始执行任务 ID:', result.task.id);
  await window.electronAPI.executeTask(result.task.id);
}

// 3. 监听任务更新
window.electronAPI.onTaskUpdated((task) => {
  console.log('📊 任务更新:', {
    id: task.id,
    status: task.status,
    title: task.title,
    logsCount: task.logs.length,
    filesCount: task.files.length
  });
});

// 4. 查看所有任务
const allTasks = await window.electronAPI.getAllTasks();
console.table(allTasks.tasks.map(t => ({
  标题: t.title,
  状态: t.status,
  文件数: t.files.length,
  日志数: t.logs.length
})));

// 5. 查看统计
const stats = await window.electronAPI.getTaskStats();
console.log('📈 任务统计:', stats.stats);
```

## 预期行为

### 成功场景
1. 任务创建后立即执行
2. 状态：pending → running → completed
3. 任务详情中可以看到：
   - 执行日志（带时间戳和级别）
   - 生成的文件列表
   - 完成时间

### 工具审批场景
如果任务需要执行危险操作（bash、write、edit），会触发：
1. 任务状态变为 `waiting_approval`
2. 弹出审批对话框，显示工具名称和参数
3. 点击"批准"后，任务继续执行
4. 点击"拒绝"后，任务失败

### 失败场景
1. 如果任务执行出错，状态变为 `failed`
2. 卡片显示错误图标和错误信息预览
3. 详情抽屉的"任务信息"标签显示完整错误

## 测试检查清单

- [ ] 任务创建成功
- [ ] 任务自动开始执行
- [ ] 任务卡片显示正确状态
- [ ] 点击卡片可以打开详情抽屉
- [ ] 详情抽屉显示实时日志
- [ ] 任务完成后状态更新为 completed
- [ ] 可以在详情中看到生成的文件列表
- [ ] 工具审批弹窗正常工作（如果触发）
- [ ] 可以暂停/取消正在执行的任务
- [ ] 可以删除已完成的任务

## 注意事项

⚠️ **当前测试环境限制**：
- Pi session 需要连接到真实的 SEP Gateway（`http://localhost:3001/gateway`）
- 如果 Gateway 未启动，任务会卡在 running 状态
- 需要有效的 refreshToken 才能与 Gateway 通信

如果看到任务一直处于 running 状态没有进展，检查：
1. SEP Gateway 是否在 3001 端口运行
2. refreshToken 是否有效
3. 主进程控制台是否有错误日志
