import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { assertSafeId, encodeTaskScopeSegment, type TaskOwnerScope } from './scope-path'
import { redactModelTraceText } from '../common/redact'
import { logger } from '../common/logger'
import type { ModelTraceEntry, ModelTraceRecorder } from '../domain/model-trace'

const log = logger.child('model-trace')
const labels = { input: '实际模型输入', thinking: '模型返回的思考内容', output: '模型输出', tool: '工具调用与结果', status: '运行与校验记录' }
interface RequestDocument {
  title: string
  phase: string
  startedAt: number
  sections: Map<string, { label: string; text: string }>
  metrics: Record<string, string | number | undefined>
}

/** Each request has its own document; the task index remains readable during parallel execution. */
export class ModelTraceStore {
  private readonly writes = new Map<string, Promise<void>>()
  private readonly documents = new Map<string, RequestDocument>()
  private readonly failedPaths = new Set<string>()
  private readonly initialized = new Set<string>()

  constructor(private readonly root: string) {}

  file(scope: TaskOwnerScope, traceId: string): string {
    assertSafeId(traceId, 'traceId')
    return join(resolve(this.root), encodeTaskScopeSegment(scope.enterpriseId, 'enterpriseId'), encodeTaskScopeSegment(scope.memberId, 'memberId'), traceId, 'model-trace.md')
  }

  requestFile(scope: TaskOwnerScope, traceId: string, requestId: string | number): string {
    assertSafeId(String(requestId), 'requestId')
    return join(dirname(this.file(scope, traceId)), 'requests', `${requestId}.md`)
  }

  recorder(scope: TaskOwnerScope, traceId: string, title: string, phase: string): ModelTraceRecorder {
    return entry => this.append(scope, traceId, { ...entry, title, phase: entry.phase || phase })
  }

  append(scope: TaskOwnerScope, traceId: string, entry: ModelTraceEntry): Promise<void> {
    const index = this.file(scope, traceId)
    const timestamp = entry.timestamp ?? Date.now()
    const previous = this.writes.get(index) ?? Promise.resolve()
    const next = previous.then(async () => {
      await mkdir(dirname(index), { recursive: true, mode: 0o700 })
      if (!this.initialized.has(index)) {
        try { await readFile(index, 'utf8') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          await writeFile(index, `# ${heading(entry.title ?? '模型运行记录')}\n\n## 运行概览\n\n开始时间：${date(timestamp)}\n\n任务标识：${traceId}\n\n## 阶段、节点与请求时间线\n\n| 时间 | 阶段或节点 | 事件与请求明细 |\n| --- | --- | --- |\n`, { encoding: 'utf8', mode: 0o600 })
          log.info('model trace document', { path: index, taskTitle: entry.title })
        }
        this.initialized.add(index)
      }
      if (entry.requestId === undefined) {
        const runtime = join(dirname(index), 'runtime.md')
        await appendFile(runtime, `\n## ${heading(entry.phase)} · ${date(timestamp)}\n\n${fenced(entry.text)}\n`, { encoding: 'utf8', mode: 0o600 })
        await appendFile(index, `| ${date(timestamp)} | ${heading(entry.phase)} | ${heading(entry.text)}；[运行明细](runtime.md) |\n`, 'utf8')
        return
      }
      const file = this.requestFile(scope, traceId, entry.requestId)
      let document = this.documents.get(file)
      if (!document) {
        document = { title: entry.title ?? '模型运行记录', phase: entry.phase, startedAt: timestamp, sections: new Map(), metrics: {} }
        this.documents.set(file, document)
        await mkdir(dirname(file), { recursive: true, mode: 0o700 })
        let exists = false
        try { await readFile(file, 'utf8'); exists = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (exists) {
          // Completed requests are released from memory; later tool records append to the same file.
          await appendFile(file, `\n## ${labels[entry.kind]} · ${date(timestamp)}\n\n${fenced(entry.text)}\n`, 'utf8')
          this.documents.delete(file)
          return
        }
        await appendFile(index, `| ${date(timestamp)} | ${heading(entry.phase)} | [第 ${entry.requestNumber ?? entry.requestId} 次请求明细](requests/${entry.requestId}.md) |\n`, 'utf8')
      }
      const key = entry.streamId !== undefined ? `${entry.kind}:${entry.streamId}` : `${entry.kind}:${document.sections.size}`
      const previousSection = document.sections.get(key)
      document.sections.set(key, { label: labels[entry.kind], text: entry.replace ? entry.text : (previousSection?.text ?? '') + entry.text })
      Object.assign(document.metrics, entry.metrics)
      const metrics = Object.entries(document.metrics).map(([key, value]) => `| ${heading(key)} | ${heading(value === undefined ? '未提供／未观测到' : String(value))} |`).join('\n')
      const body = `# ${heading(document.title)}\n\n## ${heading(document.phase)} · 第 ${entry.requestNumber ?? entry.requestId} 次模型请求\n\n开始时间：${date(document.startedAt)}\n\n请求标识：${entry.requestId}\n\n## 请求信息与耗时\n\n| 指标 | 值 |\n| --- | --- |\n${metrics}\n\n` +
        [...document.sections.values()].map(section => `## ${section.label}\n\n${fenced(section.text)}\n`).join('\n')
      const temporary = `${file}.tmp`
      await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, file)
      if (entry.completed) {
        await appendFile(index, `| ${date(timestamp)} | ${heading(entry.phase)} | ${heading(entry.text)}；[请求明细](requests/${entry.requestId}.md) |\n`, 'utf8')
        this.documents.delete(file)
      }
    }).catch(() => {
      if (entry.requestId !== undefined) this.documents.delete(this.requestFile(scope, traceId, entry.requestId))
      if (!this.failedPaths.has(index)) {
        this.failedPaths.add(index)
        log.warn('model trace write failed', { path: index, reason: '请检查日志目录权限和磁盘空间；业务任务继续运行' })
      }
    })
    this.writes.set(index, next)
    return next.finally(() => { if (this.writes.get(index) === next) this.writes.delete(index) })
  }
}

function date(timestamp: number): string { return new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) }
function heading(text: string): string { return redactModelTraceText(text).replace(/[\r\n|#]/g, ' ').slice(0, 200) }
function fenced(text: string): string {
  const safe = redactModelTraceText(text)
  let length = 3
  for (const match of safe.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
  const fence = '`'.repeat(length)
  return `${fence}text\n${safe}\n${fence}`
}
