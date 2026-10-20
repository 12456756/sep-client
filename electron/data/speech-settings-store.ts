import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { speechPermissionSchema, type SpeechPermission } from '../../src/shared/speech-contracts'
import type { SpeechSettingsPort } from '../domain/speech'
import { writeJsonAtomic } from './atomic-file'
import { WriteChain } from './write-chain'

const schema = z.object({ version: z.literal(1), permission: speechPermissionSchema }).strict()

export class SpeechSettingsStore implements SpeechSettingsPort {
  private readonly file: string
  private readonly writes = new WriteChain()

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'speech', 'settings.json')
  }

  async read(): Promise<SpeechPermission> {
    try {
      const parsed = schema.safeParse(JSON.parse(await readFile(this.file, 'utf8')) as unknown)
      return parsed.success ? parsed.data.permission : 'denied'
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 'prompt'
      return 'denied'
    }
  }

  async write(permission: SpeechPermission): Promise<void> {
    // Never recover an older grant from a backup after the user has revoked it.
    await this.writes.run(this.file, () => writeJsonAtomic(this.file, schema.parse({ version: 1, permission }), { backup: false }))
  }
}
