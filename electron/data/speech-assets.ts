import { join } from 'node:path'

export const SPEECH_MODEL_ASSETS = [
  { path: 'model.int8.onnx', bytes: 239233841, algorithm: 'sha256', hash: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
  { path: 'tokens.txt', bytes: 315894, algorithm: 'git-sha1', hash: '2cfc92fc2ff26aaa690b7c01fd96b41109413881' },
] as const

export function speechModelDirectory(resourceRoot: string): string {
  return join(resourceRoot, 'speech', 'sensevoice-int8')
}
