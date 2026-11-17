import type { Nodes } from 'mdast'
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export const messageRemarkPlugins = [remarkGfm, remarkCjkFriendly]

const summaryParser = unified().use(remarkParse).use(messageRemarkPlugins)

function plainText(node: Nodes): string {
  if (node.type === 'html' || node.type === 'definition') return ''
  if (node.type === 'break') return ' '
  if ('value' in node) return node.value
  if ('alt' in node) return node.alt ?? ''
  if ('children' in node) {
    const separator = ['root', 'blockquote', 'list', 'listItem', 'table', 'tableRow', 'footnoteDefinition'].includes(node.type) ? ' ' : ''
    return node.children.map(plainText).join(separator)
  }
  return ''
}

export function messageSummary(content: string): string {
  return plainText(summaryParser.parse(content)).replace(/\s+/g, ' ').trim()
}
