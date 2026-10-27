export interface ModelTraceEntry {
  phase: string
  kind: 'input' | 'thinking' | 'output' | 'tool' | 'status'
  requestId?: string | number
  requestNumber?: number
  streamId?: string
  text: string
  title?: string
  timestamp?: number
  /** Stream updates contain the full received block, allowing safe cross-chunk redaction. */
  replace?: boolean
  completed?: boolean
  metrics?: Record<string, string | number | undefined>
}

export type ModelTraceRecorder = (entry: ModelTraceEntry) => Promise<void>

export interface ModelTraceContext {
  taskId: string
  runId: string
  title: string
  phase: string
}

export type ModelTraceFactory = (context: ModelTraceContext) => ModelTraceRecorder | undefined
