/**
 * Map persisted task data and an optional arrangement plan to the UI model.
 *
 * TaskManager owns execution state. ArrangementService owns the frozen plan.
 * Keeping the mapping here prevents pages from reconstructing either shape.
 */

import type { ArrangementPlanSnapshot, ClientTask, ClientTaskMessage } from '../../shared/types';
import type {
  SharedContext,
  SiliconEmployee,
  WorkActivity,
  WorkItem,
  WorkMessage,
  WorkStatus,
  WorkStep,
  WorkStepState,
  WorkTimelineEntry,
} from './types';

export function toWorkStatus(status: ClientTask['status']): WorkStatus {
  switch (status) {
    case 'pending': return 'arranging';
    case 'running': return 'running';
    case 'waiting_approval': return 'waiting-user';
    case 'paused':
    case 'interrupted': return 'paused';
    case 'completed': return 'completed';
    default: return 'failed';
  }
}

function deriveStepStates(count: number, status: WorkStatus, progress: number): WorkStepState[] {
  if (!count) return [];
  if (status === 'completed') return Array.from({ length: count }, () => 'done');
  if (status === 'arranging') return Array.from({ length: count }, () => 'pending');

  const done = Math.min(count - 1, Math.max(0, Math.floor((progress / 100) * count)));
  const current: WorkStepState = status === 'running'
    ? 'running'
    : status === 'waiting-user'
      ? 'waiting-user'
      : status === 'failed'
        ? 'failed'
        : 'pending';
  return Array.from({ length: count }, (_, index) => (
    index < done ? 'done' : index === done ? current : 'pending'
  ));
}

export function completedStepCount(steps: WorkStep[]): number {
  return steps.filter(step => step.state === 'done').length;
}

function nextUserAction(status: WorkStatus, steps: WorkStep[]): string | null {
  if (status === 'waiting-user') {
    const current = steps.find(step => step.state === 'waiting-user');
    return current ? '确认「' + current.title + '」的结果后继续' : '确认当前结果后继续';
  }
  if (status === 'failed') return '查看中断原因，决定重试或换其他员工';
  if (status === 'arranging') return '检查安排并开始工作';
  return null;
}

function readableGoal(prompt: string): string {
  return prompt.trim();
}

interface BuildInput {
  task: ClientTask;
  employees: SiliconEmployee[];
  plan?: ArrangementPlanSnapshot | null;
  messages?: ClientTaskMessage[];
  streamingText?: string;
  activities?: WorkActivity[];
  activeEmployeeId?: string;
}

export function buildWorkItem({
  task,
  employees,
  plan,
  messages,
  streamingText,
  activities = [],
  activeEmployeeId,
}: BuildInput): WorkItem {
  const status = toWorkStatus(task.status);
  const progress = task.progress ?? (status === 'completed' ? 100 : 0);
  const kind: WorkItem['kind'] = plan?.mode === 'conversation' ? 'conversation' : 'arrangement';
  const nameOf = (id: string | null | undefined) => (
    employees.find(item => item.id === id)?.name ?? '硅基员工'
  );
  const stepStates = deriveStepStates(plan?.nodes.length ?? 0, status, progress);
  const steps: WorkStep[] = (plan?.nodes ?? []).map((node, index) => ({
    id: node.id,
    employeeId: node.subscriptionId,
    employeeName: nameOf(node.subscriptionId),
    title: node.title,
    input: node.instruction,
    output: node.expectedOutput,
    dependsOn: [...node.dependsOn],
    needsConfirm: node.requiresUserConfirmation,
    state: stepStates[index]!,
  }));
  const plannedParticipants = plan?.mode === 'conversation'
    ? plan.conversation?.participants.map(item => item.subscriptionId) ?? []
    : steps.map(step => step.employeeId);
  const currentEmployeeId = activeEmployeeId
    ?? plan?.conversation?.activeSubscriptionId
    ?? steps.find(step => step.state === 'running' || step.state === 'waiting-user')?.employeeId
    ?? task.subscriptionId
    ?? steps[0]?.employeeId
    ?? '';
  const goal = plan?.goal || readableGoal(task.prompt);
  const sharedContext: SharedContext = {
    goal,
    confirmedInputs: plan?.confirmedInputs ?? [],
    previousResults: [],
    userNotes: [],
  };

  return {
    id: task.id,
    title: plan?.title || task.title,
    goal,
    kind,
    status,
    progress,
    currentEmployeeId,
    currentEmployeeName: nameOf(currentEmployeeId),
    steps,
    nextUserAction: nextUserAction(status, steps),
    createdAt: task.createdAt,
    updatedAt: task.completedAt ?? task.startedAt ?? task.createdAt,
    participants: [...new Set(plannedParticipants.length ? plannedParticipants : [currentEmployeeId].filter(Boolean))],
    deliverables: task.files.map((file, index) => ({
      id: task.id + '-file-' + index,
      name: file.split(/[\\/]/).pop() || file,
      path: file,
      note: '由员工在工作过程中产出',
    })),
    timeline: buildTimeline(task, kind, nameOf(currentEmployeeId)),
    messages: buildMessages(task, messages, streamingText, currentEmployeeId, nameOf(currentEmployeeId)),
    activities,
    sharedContext,
    stopReason: task.error ?? (task.status === 'interrupted' ? '应用退出导致中断' : null),
    workDir: task.workDir,
  };
}

function buildTimeline(
  task: ClientTask,
  kind: WorkItem['kind'],
  employeeName: string,
): WorkTimelineEntry[] {
  const entries: WorkTimelineEntry[] = [
    {
      id: task.id + '-created',
      at: task.createdAt,
      actor: '你',
      text: kind === 'arrangement' ? '安排了这项工作' : '开始了一段对话',
      kind: 'create',
    },
  ];
  task.logs.forEach((log, index) => {
    entries.push({
      id: task.id + '-log-' + index,
      at: log.timestamp,
      actor: employeeName,
      text: log.message,
      kind: log.level === 'error' ? 'fail' : 'employee',
    });
  });
  task.files.forEach((file, index) => {
    entries.push({
      id: task.id + '-deliver-' + index,
      at: task.completedAt ?? task.startedAt ?? task.createdAt,
      actor: employeeName,
      text: '产出 ' + (file.split(/[\\/]/).pop() || file),
      kind: 'deliver',
    });
  });
  if (task.status === 'paused') {
    entries.push({
      id: task.id + '-stop',
      at: task.completedAt ?? Date.now(),
      actor: '你',
      text: '终止了这项工作',
      kind: 'stop',
    });
  }
  return entries.sort((left, right) => left.at - right.at);
}

function buildMessages(
  task: ClientTask,
  messages: ClientTaskMessage[] | undefined,
  streamingText: string | undefined,
  employeeId: string,
  employeeName: string,
): WorkMessage[] {
  const source: WorkMessage[] = messages?.length
    ? messages.map(message => ({
        id: message.id,
        role: message.role === 'user' ? 'user' : 'employee',
        employeeId: message.role === 'user' ? undefined : employeeId,
        employeeName: message.role === 'user' ? undefined : employeeName,
        content: message.content,
        createdAt: message.createdAt,
      }))
    : [{
        id: task.id + '-goal',
        role: 'user',
        content: readableGoal(task.prompt),
        createdAt: task.createdAt,
      }];

  if (streamingText) {
    source.push({
      id: task.id + '-streaming',
      role: 'employee',
      employeeId,
      employeeName,
      content: streamingText,
      createdAt: Date.now(),
    });
  }
  if (task.error) {
    source.push({
      id: task.id + '-error',
      role: 'system',
      content: '工作中断：' + task.error,
      createdAt: task.completedAt ?? Date.now(),
    });
  }
  return source;
}


