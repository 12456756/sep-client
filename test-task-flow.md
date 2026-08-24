# Task Management Flow Test Plan

## Test Steps

### 1. Login Flow
- [ ] Start app
- [ ] Login with credentials
- [ ] Verify token storage

### 2. Instance Selection
- [ ] Select an instance from list
- [ ] Verify `getRefreshToken` is called
- [ ] Verify `startSession` is called with correct params
- [ ] Verify route changes to 'task-board'

### 3. Task Creation (via Browser Console)
```javascript
// Create a task
const result = await window.electronAPI.createTask({
  title: 'Test Task',
  prompt: 'Write a hello world function',
  workDir: '/tmp/test-workspace'
});
console.log('Task created:', result);

// Get all tasks
const allTasks = await window.electronAPI.getAllTasks();
console.log('All tasks:', allTasks);
```

### 4. Task Execution
```javascript
// Execute the task
const taskId = result.task.id;
const execResult = await window.electronAPI.executeTask(taskId);
console.log('Execute result:', execResult);

// Monitor task updates
const unsubscribe = window.electronAPI.onTaskUpdated((task) => {
  console.log('Task updated:', task);
});

// Get task details
const taskDetails = await window.electronAPI.getTask(taskId);
console.log('Task details:', taskDetails);
```

### 5. Task State Transitions
- [ ] Verify task starts in `pending` status
- [ ] Verify task transitions to `running` when executed
- [ ] Verify task transitions to `completed` or `failed` when finished
- [ ] Check task logs are populated
- [ ] Check task files are tracked

### 6. Task Statistics
```javascript
const stats = await window.electronAPI.getTaskStats();
console.log('Task stats:', stats);
```

### 7. Error Cases
- [ ] Execute non-existent task
- [ ] Cancel running task
- [ ] Pause running task
- [ ] Delete completed task

## Expected Behavior

1. **Session Lifecycle**: Session should be created immediately after instance selection (not when entering chat)
2. **Task Status Flow**: pending → running → (completed | failed | waiting_approval)
3. **Event Propagation**: Main process events should reach renderer via IPC
4. **Token Management**: Refresh token should be retrieved from safeStorage and passed to pi session

## Known Issues to Watch

- Ensure `session.subscribe()` is used (not `session.on()`)
- Ensure `DefaultResourceLoader` has `cwd` and `agentDir` parameters
- Ensure `createAgentSession` return value is destructured: `const { session } = ...`
- Ensure tool approval requests trigger `waiting_approval` status
