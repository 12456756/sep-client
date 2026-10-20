export function imageAspectRatio(size: string): string | undefined {
  const match = /^(\d+)x(\d+)$/.exec(size)
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return undefined
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a
  const divisor = gcd(width, height)
  return `${width / divisor}:${height / divisor}`
}
