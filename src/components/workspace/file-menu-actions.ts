import { createContext, useContext } from 'react'
import { Copy, ExternalLink, FolderOpen, MessageSquarePlus, Save } from 'lucide-react'
import { canOpenResultFile, type ResultFileRequest } from '../../shared/result-files'
import { ContentMenuError, type ContentMenuCommand } from '../ContentCopyMenu'

export type AddFileToConversation = (file: ResultFileRequest) => Promise<void>
export const FileAttachmentTarget = createContext<AddFileToConversation | null>(null)

export function useFileMenuCommands(file: ResultFileRequest | null, name: string, onAdded?: () => void): ContentMenuCommand[] {
  const add = useContext(FileAttachmentTarget)
  if (!file) return []
  const run = async (action: 'open' | 'copy-path' | 'save-as') => {
    const result = await window.electronAPI.runResultFileAction({ action, file })
    if (!result.success && result.error?.message) throw new ContentMenuError(result.error.message)
    if (!result.success) throw new Error(action)
  }
  const commands: ContentMenuCommand[] = [
    { label: '打开文件夹', icon: FolderOpen, run: async () => {
      const result = await window.electronAPI.revealResultFile(file)
      if (!result.success && result.error?.message) throw new ContentMenuError(result.error.message)
      if (!result.success) throw new Error('reveal')
    } },
    { label: '在默认应用打开', icon: ExternalLink, disabledReason: canOpenResultFile(name) ? undefined : '此格式不能在默认应用中打开', run: () => run('open') },
  ]
  if (add) commands.push({ label: '添加到对话框', icon: MessageSquarePlus, separator: true, run: async () => {
      try { await add(file); onAdded?.() }
      catch (error) { if (error instanceof Error) throw new ContentMenuError(error.message); throw error }
  } })
  commands.push(
    { label: '复制路径', icon: Copy, separator: !add, run: () => run('copy-path') },
    { label: '另存为', icon: Save, separator: true, run: () => run('save-as') },
  )
  return commands
}
