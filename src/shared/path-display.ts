export interface DirectoryPathDisplayOptions {
  maxSegments?: number
  maxChars?: number
}

/** Keep directory controls readable while the full path remains available in the title. */
export function formatDirectoryPath(path: string, options: DirectoryPathDisplayOptions = {}): string {
  const value = path.trim()
  if (!value) return ''

  const maxSegments = Math.max(1, options.maxSegments ?? 3)
  const maxChars = Math.max(8, options.maxChars ?? 42)
  const separator = value.includes('\\') ? '\\' : '/'
  const segments = value.split(/[\\/]+/).filter(Boolean)
  const shortened = segments.length > maxSegments
    ? `...${separator}${segments.slice(-maxSegments).join(separator)}`
    : value

  if (shortened.length <= maxChars) return shortened
  const prefix = `...${separator}`
  const available = Math.max(1, maxChars - prefix.length)
  return `${prefix}${shortened.slice(-available)}`
}
