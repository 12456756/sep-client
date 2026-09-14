/** 工作级执行设置。权限范围与高风险动作确认策略分别配置。 */
export type RunPermissionId = 'read-only' | 'workspace-edit' | 'full-local';
export type ModelSelectionStrategy = 'per-employee' | 'same-model';

export interface RunSettings {
  /** 留空由主进程准备默认工作目录。 */
  workDir: string;
  /** 用户明确选择的模型；留空不能启动对话。 */
  model: string;
  /** 自动编排时如何为参与员工选择允许的模型。 */
  modelStrategy: ModelSelectionStrategy;
  permissionPreset: RunPermissionId;
  /** 仅跳过权限范围内的高风险动作确认，不扩大权限范围。 */
  allowWithoutApproval: boolean;
}

export const RUN_PERMISSIONS: { id: RunPermissionId; label: string; hint: string }[] = [
  { id: 'read-only', label: '仅查看资料', hint: '读取和搜索资料，不允许写入文件或执行命令' },
  { id: 'workspace-edit', label: '编辑工作目录', hint: '可以在工作目录内新建和修改文件' },
  { id: 'full-local', label: '完整本机操作', hint: '允许本机文件操作与命令执行，影响范围更大' },
];

export function defaultRunSettings(): RunSettings {
  return { workDir: '', model: '', modelStrategy: 'per-employee', permissionPreset: 'read-only', allowWithoutApproval: false };
}


