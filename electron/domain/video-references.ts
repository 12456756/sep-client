import type { VideoScope } from './video-media'
import type { UploadedVideoReference, VideoReferenceSupport, VideoReferenceView } from '../../src/shared/video-references'

export interface LocalVideoReference extends VideoReferenceView {
  sha256: string
  createdAt?: number
  uploaded?: UploadedVideoReference
}
export interface VideoReferencePort {
  list(scope: VideoScope, taskId: string): Promise<LocalVideoReference[]>
  import(scope: VideoScope, taskId: string, paths: readonly string[], support: VideoReferenceSupport, signal: AbortSignal, validate: () => void): Promise<LocalVideoReference[]>
  open(scope: VideoScope, taskId: string, id: string): Promise<{ asset: LocalVideoReference; file: Blob }>
  saveUpload(scope: VideoScope, taskId: string, id: string, uploaded: UploadedVideoReference): Promise<void>
  remove(scope: VideoScope, taskId: string, id: string): Promise<void>
}
