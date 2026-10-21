import { speechPermissionSchema, type SpeechPermission } from '../../shared/speech-contracts'

export function resolveSpeechPermission(
  response: { data?: { permission?: unknown } },
  enabled: boolean,
): SpeechPermission {
  const parsed = speechPermissionSchema.safeParse(response.data?.permission)
  return parsed.success ? parsed.data : enabled ? 'granted' : 'denied'
}
