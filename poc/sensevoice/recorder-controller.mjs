import { ipcMain } from 'electron'
import { z } from 'zod'
import channels from './recorder-channels.cjs'
import { validateAudioRequest, validateCaptureRequest } from './audio-processing.mjs'

const idSchema = z.object({ recordingId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/) }).strict()
const audioSchema = idSchema.extend({ sampleRate: z.literal(16000), samples: z.instanceof(Float32Array) }).strict()
const captureSchema = audioSchema.extend({ sampleRate: z.number().int().min(8000).max(96000) }).strict()

export function registerRecorderRoutes({ window, pageUrl, arm, prepare, recognize, cancel }) {
  const handlers = [
    [channels.ARM, idSchema, input => arm(input.recordingId)],
    [channels.PREPARE, captureSchema, input => prepare(validateCaptureRequest(input))],
    [channels.RECOGNIZE, audioSchema, input => recognize(validateAudioRequest(input))],
    [channels.CANCEL, idSchema, input => cancel(input.recordingId)],
  ]
  for (const [channel, schema, execute] of handlers) {
    ipcMain.handle(channel, async (event, raw) => {
      const current = window()
      if (!current || event.sender !== current.webContents || event.senderFrame !== current.webContents.mainFrame
        || event.senderFrame.url !== pageUrl) return { ok: false, error: 'UNTRUSTED_SOURCE' }
      try { return { ok: true, data: await execute(schema.parse(raw)) } }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Recognition failed'
        return { ok: false, error: message }
      }
    })
  }
  return () => { for (const [channel] of handlers) ipcMain.removeHandler(channel) }
}
