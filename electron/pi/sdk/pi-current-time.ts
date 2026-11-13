import { Type } from 'typebox'
import { z } from 'zod'
import type { PiToolDefinition } from './pi-coding-agent-adapter'

export const CURRENT_TIME_TOOL_NAME = 'get_current_time'

const inputSchema = z.object({ timezone: z.string().trim().min(1).max(128).optional() }).strict()

export function currentTimeToolDefinition(now: () => number = Date.now): PiToolDefinition {
  return {
    name: CURRENT_TIME_TOOL_NAME,
    label: '查询当前时间',
    promptSnippet: 'Read the current date, time and timezone from the computer clock.',
    description: 'Read the current date and time directly from the computer system clock. Returns local time with UTC offset, UTC time, timezone, weekday and Unix timestamp in milliseconds. Use this tool for current-time queries instead of opening websites or running shell commands. The computer clock may differ from an authoritative network clock.',
    promptGuidelines: ['Use get_current_time when you need the current date or time. Supply the requested IANA timezone, such as Asia/Shanghai; omit it to use the computer timezone.'],
    parameters: Type.Object({ timezone: Type.Optional(Type.String({ description: 'IANA timezone, for example Asia/Shanghai or UTC. Defaults to the computer timezone.' })) }, { additionalProperties: false }),
    async execute(_id, input, signal) {
      signal?.throwIfAborted()
      const parsed = inputSchema.safeParse(input)
      if (!parsed.success) throw new Error('Invalid time query. Supply {} or {"timezone":"Asia/Shanghai"}.')
      let formatter: Intl.DateTimeFormat
      try {
        formatter = new Intl.DateTimeFormat('en-CA', {
          ...(parsed.data.timezone ? { timeZone: parsed.data.timezone } : {}),
          year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
        })
      } catch {
        throw new Error('Invalid timezone. Use an IANA timezone such as Asia/Shanghai, America/New_York or UTC.')
      }
      const timestampMs = now()
      const parts = formatter.formatToParts(timestampMs)
      const part = (name: Intl.DateTimeFormatPartTypes): string => parts.find(item => item.type === name)!.value
      const offset = part('timeZoneName').replace('GMT', '') || '+00:00'
      const result = {
        localTime: `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset}`,
        utcTime: new Date(timestampMs).toISOString(),
        timezone: formatter.resolvedOptions().timeZone,
        weekday: part('weekday'), timestampMs, source: 'system-clock',
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
    },
  }
}
