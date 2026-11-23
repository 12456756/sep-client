export function localMediaTarget(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) return `mac-${arch}`
  return undefined
}

export function localMediaExecutable(tool: 'ffmpeg' | 'ffprobe', platform = process.platform): string {
  return platform === 'win32' ? `${tool}.exe` : tool
}

export function localMediaH264Args(bitrate: string, platform = process.platform): string[] {
  return ['-pix_fmt', 'nv12', '-c:v', platform === 'darwin' ? 'h264_videotoolbox' : 'h264_mf',
    ...(platform === 'darwin' ? ['-allow_sw', '1', '-bf', '0'] : []), '-b:v', bitrate]
}
