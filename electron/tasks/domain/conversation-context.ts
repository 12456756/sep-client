import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface ConversationMessage {
  id: string
  taskId: string
  turnId: string
  runId: string
  employeeInstanceId: string
  modelId: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  createdAt: number
}

export interface EmployeeSessionBinding {
  employeeInstanceId: string
  sessionId: string
  sessionFile: string | null
  lastRunId: string
  updatedAt: number
}

/** Durable Pi session shared by all turns in one conversation task. */
export interface SharedConversationSessionBinding {
  sessionId: string
  sessionFile: string | null
  lastRunId: string
  updatedAt: number
}

export interface ConversationContextStorePort {
  appendMessage(message: ConversationMessage): Promise<void>
  listMessages(): Promise<ConversationMessage[]>
  getEmployeeSession(employeeInstanceId: string): Promise<EmployeeSessionBinding | null>
  setEmployeeSession(binding: EmployeeSessionBinding): Promise<void>
  getSharedSession(): Promise<SharedConversationSessionBinding | null>
  setSharedSession(binding: SharedConversationSessionBinding): Promise<void>
}

export class ConversationContextStore implements ConversationContextStorePort {
  private readonly messagesFile: string
  private readonly sessionsFile: string
  private readonly sharedSessionFile: string
  private writeChain: Promise<void> = Promise.resolve()

  constructor(taskDir: string) {
    this.messagesFile = join(taskDir, 'conversation', 'messages.jsonl')
    this.sessionsFile = join(taskDir, 'conversation', 'participants.json')
    this.sharedSessionFile = join(taskDir, 'conversation', 'session.json')
  }

  appendMessage(message: ConversationMessage): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(dirname(this.messagesFile), { recursive: true })
      await appendFile(this.messagesFile, `${JSON.stringify(message)}\n`, { encoding: 'utf8', mode: 0o600 })
    })
  }

  async listMessages(): Promise<ConversationMessage[]> {
    try {
      const content = await readFile(this.messagesFile, 'utf8')
      return content.split(/\r?\n/).filter(Boolean).flatMap(line => {
        try {
          const value = JSON.parse(line) as ConversationMessage
          return value && typeof value.id === 'string' && typeof value.content === 'string' ? [value] : []
        } catch { return [] }
      })
    } catch { return [] }
  }

  async getEmployeeSession(employeeInstanceId: string): Promise<EmployeeSessionBinding | null> {
    try {
      const entries = JSON.parse(await readFile(this.sessionsFile, 'utf8')) as Record<string, EmployeeSessionBinding>
      const value = entries[employeeInstanceId]
      return value && value.employeeInstanceId === employeeInstanceId ? { ...value } : null
    } catch { return null }
  }

  setEmployeeSession(binding: EmployeeSessionBinding): Promise<void> {
    return this.enqueue(async () => {
      let entries: Record<string, EmployeeSessionBinding> = {}
      try { entries = JSON.parse(await readFile(this.sessionsFile, 'utf8')) as Record<string, EmployeeSessionBinding> } catch { /* create file */ }
      entries[binding.employeeInstanceId] = { ...binding }
      await mkdir(dirname(this.sessionsFile), { recursive: true })
      await writeFile(this.sessionsFile, JSON.stringify(entries), { encoding: 'utf8', mode: 0o600 })
    })
  }

  async getSharedSession(): Promise<SharedConversationSessionBinding | null> {
    try {
      const binding = JSON.parse(await readFile(this.sharedSessionFile, 'utf8')) as SharedConversationSessionBinding
      return binding && typeof binding.sessionId === 'string' &&
        (typeof binding.sessionFile === 'string' || binding.sessionFile === null) &&
        typeof binding.lastRunId === 'string' && typeof binding.updatedAt === 'number'
        ? { ...binding }
        : null
    } catch { return null }
  }

  setSharedSession(binding: SharedConversationSessionBinding): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(dirname(this.sharedSessionFile), { recursive: true })
      await writeFile(this.sharedSessionFile, JSON.stringify(binding), { encoding: 'utf8', mode: 0o600 })
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeChain.catch(() => undefined).then(operation)
    this.writeChain = next
    return next
  }
}
