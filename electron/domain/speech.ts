import type { SpeechAudio, SpeechPermission, SpeechResult } from '../../src/shared/speech-contracts'

export interface SpeechSettingsPort {
  read(): Promise<SpeechPermission>
  write(permission: SpeechPermission): Promise<void>
}

export interface SpeechRuntimePort {
  recognize(input: SpeechAudio): Promise<SpeechResult>
  stop(): void
}
