import { z } from 'zod'
import { knowledgeIdSchema } from './knowledge-contracts'

export const knowledgeSourceRefSchema = z.object({
  knowledgeBaseId: knowledgeIdSchema,
  sourceId: knowledgeIdSchema,
}).strict()

/** Only scope and source identities cross IPC; the host fetches citation text again. */
export const knowledgeSelectionSchema = z.object({
  mode: z.enum(['none', 'auto', 'manual']),
  knowledgeBaseIds: z.array(knowledgeIdSchema).max(100).refine(ids => new Set(ids).size === ids.length),
  manualQuery: z.string().trim().max(1000).optional(),
  sources: z.array(knowledgeSourceRefSchema).max(20).optional(),
}).strict().superRefine((selection, context) => {
  if ((selection.mode === 'none') !== (selection.knowledgeBaseIds.length === 0)) {
    context.addIssue({ code: 'custom', path: ['knowledgeBaseIds'], message: '不使用时范围必须为空；启用时至少选择一个知识库。' })
  }
  if (selection.mode !== 'manual' && (selection.manualQuery !== undefined || selection.sources !== undefined)) {
    context.addIssue({ code: 'custom', message: '只有手动模式可以指定查询和引用。' })
  }
  const refs = new Set<string>()
  for (const source of selection.sources ?? []) {
    const key = JSON.stringify([source.knowledgeBaseId, source.sourceId])
    if (!selection.knowledgeBaseIds.includes(source.knowledgeBaseId) || refs.has(key)) {
      context.addIssue({ code: 'custom', path: ['sources'], message: '引用必须唯一且属于选定的知识库。' })
    }
    refs.add(key)
  }
})

export type KnowledgeSelection = z.infer<typeof knowledgeSelectionSchema>
export type KnowledgeSourceRef = z.infer<typeof knowledgeSourceRefSchema>

export function noKnowledgeSelection(): KnowledgeSelection {
  return { mode: 'none', knowledgeBaseIds: [] }
}
