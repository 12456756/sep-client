import { z } from 'zod'

export const documentPreviewRequestSchema = z.object({
  taskId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  nodeId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  deliverableId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
}).strict()
export type DocumentPreviewRequest = z.infer<typeof documentPreviewRequestSchema>

const sectionSchema = z.object({ title: z.string(), html: z.string() }).strict()
export const documentPreviewContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pdf'), bytes: z.instanceof(Uint8Array) }).strict(),
  z.object({ kind: z.literal('html'), sections: z.array(sectionSchema).min(1), notices: z.array(z.string()) }).strict(),
  z.object({ kind: z.enum(['text', 'markdown']), text: z.string() }).strict(),
])
export type DocumentPreviewContent = z.infer<typeof documentPreviewContentSchema>
export interface DocumentPreview {
  name: string
  format: string
  version: string
  source: 'snapshot' | 'recovered-snapshot' | 'verified-original'
  content: DocumentPreviewContent
}

const formats = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'html', 'css', 'js', 'ts', 'py', 'yaml', 'yml', 'sql', 'log'])
export function supportsDocumentPreview(format: string): boolean {
  return formats.has(format.toLowerCase().replace(/^\./, ''))
}
