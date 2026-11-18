import { z } from 'zod'

export const contextUsageSchema = z.object({
  tokens: z.number().finite().nonnegative().nullable(),
  contextWindow: z.number().finite().positive(),
  percent: z.number().finite().nonnegative().nullable(),
  breakdown: z.object({
    system: z.number().int().nonnegative(),
    tools: z.number().int().nonnegative(),
    messages: z.number().nonnegative(),
  }).strict().optional(),
}).strict().refine(usage => !usage.breakdown || usage.tokens !== null &&
  Math.abs(usage.breakdown.system + usage.breakdown.tools + usage.breakdown.messages - usage.tokens) < 0.001)

export type ContextUsage = z.infer<typeof contextUsageSchema>

export function formatContextTokens(tokens: number): string {
  return tokens >= 1_000 ? `${Number((tokens / 1_000).toFixed(1))}K` : String(Math.round(tokens))
}

export function contextUsageLabel(usage: ContextUsage | null): { text: string; detail: string } {
  if (!usage || usage.tokens === null || usage.percent === null) return {
    text: '--', detail: '当前上下文用量暂不可用，将在模型响应后更新。',
  }
  return {
    text: `${Math.round(usage.percent)}%`,
    detail: `当前上下文约 ${Math.round(usage.tokens).toLocaleString('zh-CN')} / ${usage.contextWindow.toLocaleString('zh-CN')} Token（${usage.percent.toFixed(1)}%）`,
  }
}
