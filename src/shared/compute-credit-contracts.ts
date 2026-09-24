import { z } from 'zod'

/** SEP monetary values are decimal strings; keep them as strings to avoid float rounding. */
export const moneyStringSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/, 'money must be a decimal string')

const nullableMoney = moneyStringSchema.nullable()
const nullableNumber = z.number().finite().nullable()

export const computeAllowanceSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  departmentName: z.string().nullable().optional(),
  limitCNY: nullableMoney,
  period: z.string(),
  periodLabel: z.string().optional(),
  carryOver: z.boolean().optional(),
  enabled: z.boolean(),
  carriedInCNY: moneyStringSchema.optional(),
  usedCNY: moneyStringSchema,
  remainingCNY: nullableMoney,
  topUpRemainingCNY: moneyStringSchema,
  totalRemainingCNY: nullableMoney,
  usedPct: nullableNumber,
  periodStart: z.string().optional(),
  resetAt: z.string().optional(),
  dailyLimitCNY: nullableMoney.optional(),
  dailyUsedCNY: moneyStringSchema.optional(),
  dailyRemainingCNY: nullableMoney.optional(),
  monthlyLimitCNY: nullableMoney.optional(),
  monthlyUsedCNY: moneyStringSchema.optional(),
  monthlyRemainingCNY: nullableMoney.optional(),
  dailyBypassUntil: z.string().nullable().optional(),
  dailyBypassActive: z.boolean().optional(),
  topUpAmountCNY: moneyStringSchema.optional(),
  topUpConsumedCNY: moneyStringSchema.optional(),
}).passthrough()

export const personalWalletSchema = z.object({
  balanceCNY: moneyStringSchema,
  totalDepositCNY: moneyStringSchema,
  totalConsumeCNY: moneyStringSchema,
}).passthrough()

export const walletTransactionSchema = z.object({
  id: z.string(),
  type: z.enum(['DEPOSIT', 'CONSUME', 'REFUND', 'ADJUSTMENT']),
  amountCNY: moneyStringSchema,
  balanceAfterCNY: moneyStringSchema,
  description: z.string().optional(),
  relatedType: z.string().nullable().optional(),
  relatedId: z.string().nullable().optional(),
  createdAt: z.string(),
}).passthrough()

export const computeUsageRecordSchema = z.object({
  id: z.string().optional(),
  createdAt: z.string().optional(),
  costCNY: moneyStringSchema.optional(),
  creditPaidCNY: moneyStringSchema.optional(),
  memberWalletPaidCNY: moneyStringSchema.optional(),
  walletPaidCNY: moneyStringSchema.optional(),
  personalPaidCNY: moneyStringSchema.optional(),
  unpaidCNY: moneyStringSchema.optional(),
}).passthrough()

const pageFields = {
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
  totalPages: z.number().int().nonnegative(),
}

export const walletTransactionsPageSchema = z.object({
  ...pageFields,
  records: z.array(walletTransactionSchema),
}).passthrough()

export const computeUsageRecordsPageSchema = z.object({
  ...pageFields,
  records: z.array(computeUsageRecordSchema),
}).passthrough()

export const computeUsageBreakdownSchema = z.object({
  days: z.number().int().positive().optional(),
  totals: z.record(z.string(), z.unknown()).optional(),
  series: z.array(z.unknown()).optional(),
  daily: z.array(z.unknown()).optional(),
}).passthrough()

export const computePageQuerySchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
})

export const computeUsageQuerySchema = computePageQuerySchema.extend({
  employeeId: z.string().trim().min(1).max(256).optional(),
  memberId: z.string().trim().min(1).max(256).optional(),
  startDate: z.string().trim().min(1).max(64).optional(),
  endDate: z.string().trim().min(1).max(64).optional(),
})

export const computeBreakdownDaysSchema = z.union([z.literal(7), z.literal(30), z.literal(90)])

export type ComputeAllowance = z.infer<typeof computeAllowanceSchema>
export type PersonalWallet = z.infer<typeof personalWalletSchema>
export type WalletTransaction = z.infer<typeof walletTransactionSchema>
export type WalletTransactionsPage = z.infer<typeof walletTransactionsPageSchema>
export type ComputeUsageRecord = z.infer<typeof computeUsageRecordSchema>
export type ComputeUsageRecordsPage = z.infer<typeof computeUsageRecordsPageSchema>
export type ComputeUsageBreakdown = z.infer<typeof computeUsageBreakdownSchema>
export type ComputePageQuery = z.infer<typeof computePageQuerySchema>
export type ComputeUsageQuery = z.infer<typeof computeUsageQuerySchema>
export type ComputeBreakdownDays = z.infer<typeof computeBreakdownDaysSchema>
