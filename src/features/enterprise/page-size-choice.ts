export type PageSizeChoice = 'auto' | `${number}`

export function parsePageSizeChoice(value: string | null): PageSizeChoice | null {
  if (value === 'auto') return value
  const size = Number(value)
  return value?.trim() && Number.isSafeInteger(size) && size > 0 ? `${size}` : null
}
