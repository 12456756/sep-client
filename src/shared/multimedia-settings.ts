import type { MediaCapabilities } from './media'
import type { VideoRuntime } from './video-media'

export interface MultimediaSettings {
  image: MediaCapabilities | null
  imageError: string | null
  video: VideoRuntime | null
}
