export function platformSourceHeaders(baseUrl: string): { Origin: string; Referer: string } {
  const origin = new URL(baseUrl).origin
  return { Origin: origin, Referer: origin + '/' }
}
