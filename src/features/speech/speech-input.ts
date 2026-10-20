import { SpeechInputController } from './speech-controller'

export const speechInput = new SpeechInputController({
  api: () => window.electronAPI,
  capture: async options => (await import('./browser-capture')).createMicrophoneCapture(options),
})
