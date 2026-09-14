import { TaskStatus, type ClientTaskStatus } from '../../src/shared/types'

const transitions: Record<ClientTaskStatus, readonly ClientTaskStatus[]> = {
  [TaskStatus.PENDING]: [TaskStatus.RUNNING, TaskStatus.PAUSED, TaskStatus.INTERRUPTED, TaskStatus.FAILED],
  [TaskStatus.RUNNING]: [TaskStatus.PENDING, TaskStatus.WAITING_APPROVAL, TaskStatus.PAUSED, TaskStatus.INTERRUPTED, TaskStatus.COMPLETED, TaskStatus.FAILED],
  [TaskStatus.WAITING_APPROVAL]: [TaskStatus.PENDING, TaskStatus.RUNNING, TaskStatus.PAUSED, TaskStatus.INTERRUPTED, TaskStatus.FAILED],
  [TaskStatus.PAUSED]: [TaskStatus.PENDING, TaskStatus.INTERRUPTED],
  [TaskStatus.INTERRUPTED]: [TaskStatus.PENDING, TaskStatus.FAILED],
  [TaskStatus.COMPLETED]: [TaskStatus.PENDING],
  [TaskStatus.FAILED]: [TaskStatus.PENDING],
}

export class InvalidTaskTransitionError extends Error {
  readonly from: ClientTaskStatus
  readonly to: ClientTaskStatus

  constructor(from: ClientTaskStatus, to: ClientTaskStatus) {
    super(`Task cannot transition from ${from} to ${to}.`)
    this.name = 'InvalidTaskTransitionError'
    this.from = from
    this.to = to
  }
}

export class TaskAdmissionError extends Error {
  constructor(message = 'Task already has an active execution.') {
    super(message)
    this.name = 'TaskAdmissionError'
  }
}

export function canTransitionTask(from: ClientTaskStatus, to: ClientTaskStatus): boolean {
  return from === to || transitions[from].includes(to)
}

export function assertTaskTransition(from: ClientTaskStatus, to: ClientTaskStatus): void {
  if (!canTransitionTask(from, to)) throw new InvalidTaskTransitionError(from, to)
}

export function isTaskTerminal(status: ClientTaskStatus): boolean {
  return status === TaskStatus.COMPLETED || status === TaskStatus.FAILED
}

export function isTaskExecutionStatus(status: ClientTaskStatus): boolean {
  return status === TaskStatus.RUNNING || status === TaskStatus.WAITING_APPROVAL
}


