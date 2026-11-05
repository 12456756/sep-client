import { z } from 'zod'

const modelCatalogEntrySchema = z.object({
  modelId: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  displayName: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  billingMultiplier: z.string().nullable().optional(),
  discountLabel: z.string().nullable().optional(),
  isFree: z.boolean().optional(),
  vision: z.boolean().nullable().optional(),
}).passthrough()

export interface ModelCatalogEntry {
  modelId: string
  displayName: string
  billingMultiplier: string | null
  discountLabel: string | null
  isFree: boolean | null
  vision: boolean | null
}

/** Older SEP deployments may omit the billing fields until the billing release is deployed. */
export const modelCatalogSchema = z.array(modelCatalogEntrySchema).transform(entries => entries.map(entry => {
  const modelId = entry.modelId ?? entry.id
  if (!modelId) throw new Error('SEP model catalog item is missing modelId')
  return {
    modelId,
    displayName: entry.displayName?.trim() || entry.label?.trim() || modelId,
    billingMultiplier: entry.billingMultiplier ?? null,
    discountLabel: entry.discountLabel?.trim() || null,
    isFree: entry.isFree ?? null,
    vision: entry.vision ?? null,
  } satisfies ModelCatalogEntry
}))

export function modelBillingLabel(model: Pick<ModelCatalogEntry, 'billingMultiplier' | 'discountLabel'>): string | null {
  if (model.billingMultiplier !== null) return `${model.billingMultiplier}×`
  return model.discountLabel
}
