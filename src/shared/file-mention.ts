import type { AttachmentRef, AttachmentView } from './attachment-contracts'

export interface FileMention { start: number; end: number; attachment: AttachmentRef }
export interface MentionQuery { start: number; end: number; query: string }
export type FileMentionDraft = { text: string; mentions: FileMention[] }
export interface FileMentionMemory { draft?: FileMentionDraft; history?: FileMentionDraft[]; redo?: FileMentionDraft[]; mentionOnly?: Set<string>; imported?: Map<string, string> }

export function fileMentionQuery(text: string, caret: number): MentionQuery | null {
  const prefix = text.slice(0, caret)
  if ((prefix.match(/^\s*(?:```|~~~)/gm)?.length ?? 0) % 2) return null
  const match = /(^|[^\p{L}\p{N}_.:/+%@＠-]|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[@＠]([^\s@＠`<>/\\]*)$/u.exec(prefix)
  if (!match || (prefix.match(/`/g)?.length ?? 0) % 2) return null
  const start = match.index + match[1].length
  const word = prefix.slice(0, start).split(/\s/u).at(-1) ?? ''
  if (/(?:https?:\/\/|www\.|mailto:)/i.test(word)) return null
  return { start, end: caret, query: match[2] }
}

/** Preserve ranges outside the edit; touching a reference invalidates that occurrence. */
export function moveFileMentions(before: string, after: string, mentions: readonly FileMention[], selection?: { start: number; end: number }): FileMention[] {
  if (before === after) return [...mentions]
  let start = 0, oldEnd = before.length, newEnd = after.length
  const insertedEnd = selection && selection.end + after.length - before.length
  if (selection && insertedEnd !== undefined && insertedEnd >= selection.start && before.slice(0, selection.start) === after.slice(0, selection.start) && before.slice(selection.end) === after.slice(insertedEnd)) {
    start = selection.start; oldEnd = selection.end; newEnd = insertedEnd
  } else {
    while (start < oldEnd && start < newEnd && before[start] === after[start]) start++
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd-- }
  }
  const delta = newEnd - oldEnd
  return mentions.flatMap(item => item.end <= start ? [item] : item.start >= oldEnd ? [{ ...item, start: item.start + delta, end: item.end + delta }] : [])
}

export function resolveMentionAttachments(items: readonly AttachmentView[], mentions: readonly FileMention[], mentionOnly: ReadonlySet<string>) {
  const key = (item: AttachmentRef) => `${item.attachmentId}:${item.sha256}`
  const attached = new Map(items.map(item => [key(item), item]))
  const selected = new Set(mentions.map(item => key(item.attachment)))
  const unreferenced = items.filter(item => !mentionOnly.has(item.attachmentId) && !selected.has(key(item)))
  return { invalid: [...selected].some(id => !attached.has(id)), items: items.filter(item => !mentionOnly.has(item.attachmentId) || selected.has(key(item))), unreferenced }
}

export function distinguishSameNameMentions(text: string, mentions: readonly FileMention[], attachments: readonly AttachmentView[]): string {
  const names = new Map<string, number>()
  for (const item of attachments) names.set(item.displayName, (names.get(item.displayName) ?? 0) + 1)
  let result = text
  for (const mark of [...mentions].sort((a, b) => b.end - a.end)) {
    const index = attachments.findIndex(item => item.attachmentId === mark.attachment.attachmentId && item.sha256 === mark.attachment.sha256)
    const item = attachments[index]
    if (item && (names.get(item.displayName) ?? 0) > 1) result = `${result.slice(0, mark.end)}（本轮附件 ${index + 1}）${result.slice(mark.end)}`
  }
  return result
}
