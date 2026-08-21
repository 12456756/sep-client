/** Provider-neutral authorization header policy. SDK-specific hooks live in electron/pi/sdk. */

export function buildBearerAuthorizationHeader(token: string): string {
  return `Bearer ${token}`
}
