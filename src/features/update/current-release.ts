export interface CurrentRelease {
  version: string
  notes: string
}

declare const __SEP_CURRENT_RELEASE__: CurrentRelease | undefined

export function getCurrentRelease(
  version: string,
  release: CurrentRelease | null = typeof __SEP_CURRENT_RELEASE__ === 'undefined' ? null : __SEP_CURRENT_RELEASE__ ?? null,
): CurrentRelease | null {
  return release?.version === version && release.notes.trim() ? release : null
}
