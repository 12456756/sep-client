import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import {
  createBashToolDefinition, createGrepToolDefinition, createReadToolDefinition, defineTool, type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { createEncodingBashOperations } from './pi-bash-operations'
import { decodeToolText, utf8ChildEnvironment } from './pi-text-encoding'

function encodingReadTool(cwd: string): ReturnType<typeof createReadToolDefinition> {
  const original = createReadToolDefinition(cwd)
  return {
    ...original,
    async execute(id, input, signal, onUpdate, ctx) {
      const baseline = await original.execute(id, input, signal, onUpdate, ctx)
      // Keep the SDK's image detection/processing untouched. Retry only the local text read,
      // not a model or command, when the result shows a byte-decoding problem.
      // eslint-disable-next-line no-control-regex
      if (!baseline.content.some(part => part.type === 'text' && /[\ufffd\u0000]/u.test(part.text))) return baseline
      if (baseline.content.some(part => part.type === 'image')) return baseline
      let recovered = false
      const textReader = createReadToolDefinition(cwd, { operations: {
        access: path => access(path, constants.R_OK),
        async readFile(path) {
          const bytes = await readFile(path)
          const text = decodeToolText(bytes)
          recovered = text !== bytes.toString('utf8')
          return recovered ? Buffer.from(text, 'utf8') : bytes
        },
      } })
      try {
        const result = await textReader.execute(id, input, signal, undefined, ctx)
        if (signal?.aborted) throw new Error('Operation aborted')
        return recovered ? result : baseline
      } catch (error) {
        if (signal?.aborted) throw error
        return baseline
      }
    },
  }
}

export function encodingToolDefinitions(cwd: string): ToolDefinition[] {
  return [
    defineTool(createBashToolDefinition(cwd, {
      operations: createEncodingBashOperations(),
      spawnHook: context => ({ ...context, env: utf8ChildEnvironment(context.env) }),
    })),
    defineTool(encodingReadTool(cwd)),
    defineTool(createGrepToolDefinition(cwd, { operations: {
      isDirectory: async path => (await stat(path)).isDirectory(),
      readFile: async path => decodeToolText(await readFile(path)),
    } })),
  ]
}
