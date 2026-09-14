/**
 * 一项工作的执行设置：在哪做、用哪个模型、允许员工做什么。
 *
 * 这三样都不放在第一视觉层 —— 见「执行设置」抽屉。默认刻意保守：
 * 只有「文件读取」开着，写入、联网、执行命令一律要用户自己打开，
 * 和 placeholder.ts 里 defaultPermissions() 的默认一致。
 *
 * 这里只是用户的意愿表达，真正的拦截仍然在 pi-extension/guard.ts：
 * 即使打开了「文件写入」，每次改写前 SDK 钩子还会单独问一次。
 */

export type RunPermissionId = 'read-files' | 'write-files' | 'browser' | 'shell';

export interface RunSettings {
  /** 空表示用默认工作目录，由主进程准备。 */
  workDir: string;
  /** 空表示用企业指定的模型。 */
  model: string;
  permissions: Record<RunPermissionId, boolean>;
}

/** 抽屉里那四行开关。顺序按「影响范围从小到大」排。 */
export const RUN_PERMISSIONS: { id: RunPermissionId; label: string; hint: string }[] = [
  { id: 'read-files', label: '文件读取', hint: '读取工作目录里的资料' },
  { id: 'write-files', label: '文件写入', hint: '在工作目录里新建和改写文件，每次改写前仍会问你一次' },
  { id: 'browser', label: '网络访问', hint: '打开网页查资料' },
  { id: 'shell', label: '执行命令', hint: '运行系统命令，影响范围可能超出工作目录' },
];

export function defaultRunSettings(): RunSettings {
  return {
    workDir: '',
    model: '',
    permissions: { 'read-files': true, 'write-files': false, browser: false, shell: false },
  };
}
