const mediaTypes = new Map([
  ['.mp4', 'video/mp4'], ['.mov', 'video/quicktime'], ['.mkv', 'video/x-matroska'], ['.webm', 'video/webm'],
  ['.mp3', 'audio/mpeg'], ['.m4a', 'audio/mp4'], ['.wav', 'audio/wav'], ['.flac', 'audio/flac'],
  ['.ogg', 'audio/ogg'], ['.aac', 'audio/aac'],
])

export function attachmentAudioVideoType(extension: string): string | undefined {
  return mediaTypes.get(extension.toLowerCase())
}

export function isAttachmentAudioVideo(mediaType: string): boolean {
  return mediaType.startsWith('video/') || mediaType.startsWith('audio/')
}
