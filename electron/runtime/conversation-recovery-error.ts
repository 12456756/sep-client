export type ConversationRecoveryCode = 'SESSION_UNRECOVERABLE' | 'RECOVERY_CONFIRMATION_REQUIRED'

export class ConversationRecoveryError extends Error {
  constructor(readonly code: ConversationRecoveryCode, message: string) {
    super(message)
    this.name = 'ConversationRecoveryError'
  }
}


