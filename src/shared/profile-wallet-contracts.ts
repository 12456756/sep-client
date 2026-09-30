import { z } from 'zod'

export const clientProfileSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    avatar: z.string().nullable(),
    role: z.string(),
  }).passthrough(),
  enterprise: z.object({
    id: z.string(),
    name: z.string(),
    logo: z.string().nullable(),
  }).passthrough().nullable(),
}).passthrough()

export const userAvatarUploadResponseSchema = z.object({ avatar: z.string() }).passthrough()
export const enterpriseLogoUploadResponseSchema = z.object({ logo: z.string() }).passthrough()

const decimalAmount = z.number().finite().positive().max(100000).refine(
  value => /^\d+(?:\.\d{1,2})?$/.test(String(value)),
  'amountCNY must have at most two decimal places',
)

export const personalRechargeRequestSchema = z.object({
  amountCNY: decimalAmount,
  returnUrl: z.string().url().max(2048).optional(),
}).strict()

export const personalRechargeStatusSchema = z.enum(['PENDING', 'PAID', 'CLOSED'])

export const personalRechargeOrderSchema = z.object({
  orderId: z.string(),
  orderNo: z.string(),
  amountCNY: z.string().regex(/^\d+(?:\.\d+)?$/),
  payUrl: z.string(),
  status: personalRechargeStatusSchema.optional(),
  payChannel: z.string().optional(),
  paidAt: z.string().nullable().optional(),
  createdAt: z.string().optional(),
}).passthrough()

export const personalRechargeStatusResponseSchema = z.object({
  orderNo: z.string(),
  amountCNY: z.string().regex(/^\d+(?:\.\d+)?$/),
  status: personalRechargeStatusSchema,
  payChannel: z.string().optional(),
  paidAt: z.string().nullable().optional(),
  createdAt: z.string().optional(),
}).passthrough()

export const personalRechargeQuerySchema = z.string().trim().min(1).max(128)

export const personalRechargeReconcileSchema = z.object({
  status: personalRechargeStatusSchema,
  reconciled: z.boolean(),
}).passthrough()

export type ClientProfile = z.infer<typeof clientProfileSchema>
export type UserAvatarUploadResponse = z.infer<typeof userAvatarUploadResponseSchema>
export type EnterpriseLogoUploadResponse = z.infer<typeof enterpriseLogoUploadResponseSchema>
export type PersonalRechargeRequest = z.infer<typeof personalRechargeRequestSchema>
export type PersonalRechargeStatus = z.infer<typeof personalRechargeStatusSchema>
export type PersonalRechargeOrder = z.infer<typeof personalRechargeOrderSchema>
export type PersonalRechargeStatusResponse = z.infer<typeof personalRechargeStatusResponseSchema>
export type PersonalRechargeReconcileResult = z.infer<typeof personalRechargeReconcileSchema>
