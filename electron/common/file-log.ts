import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { addLogSink, logger, type LogSink } from './logger'

/** A bounded diagnostic journal; content/debug records are deliberately excluded. */
export function installFileLogging(directory: string, maxBytes = 1_048_576): () => void {
  const path = join(directory, 'errors.jsonl')
  let disabled = false
  const sink: LogSink = record => {
    if (disabled || (record.level !== 'warn' && record.level !== 'error')) return
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      let line = JSON.stringify(record) + '\n'
      if (Buffer.byteLength(line) > maxBytes) {
        line = JSON.stringify({ timestamp: record.timestamp, level: record.level, scope: record.scope.slice(0, 80),
          message: 'Diagnostic record exceeded file size limit', fields: { truncated: true } }) + '\n'
      }
      if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > maxBytes) {
        rmSync(`${path}.2`, { force: true })
        if (existsSync(`${path}.1`)) renameSync(`${path}.1`, `${path}.2`)
        renameSync(path, `${path}.1`)
      }
      appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // Disable before logging so an unwritable disk cannot recurse or break the operation.
      disabled = true
      logger.child('file-log').warn('diagnostic file logging unavailable')
    }
  }
  return addLogSink(sink)
}
