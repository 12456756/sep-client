import { Upload } from 'lucide-react'
import { useState, type DragEvent, type ReactNode, type RefCallback } from 'react'

type Props = {
  children: ReactNode
  className: string
  as?: 'div' | 'aside' | 'section'
  surfaceRef?: RefCallback<HTMLElement>
  'aria-label'?: string
  disabled: boolean
  editorVersion?: number | null
} & ({ composerId: string; onFiles?: never } | { composerId?: never; onFiles: (files: FileList) => void })

function isFileDrag(event: DragEvent<HTMLElement>): boolean {
  return event.target instanceof Node && event.currentTarget.contains(event.target) &&
    (event.dataTransfer.types.includes('Files') || event.dataTransfer.files.length > 0)
}

export function AttachmentDropZone({ children, className, as: Surface = 'div', surfaceRef, composerId, disabled, editorVersion, onFiles, 'aria-label': label }: Props) {
  const [dragging, setDragging] = useState(false)
  const dragOver = (event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
    setDragging(!disabled)
  }
  return (
    <Surface ref={surfaceRef} className={`${className} ent-attachment-drop-zone`} aria-label={label}
      data-composer-id={editorVersion === undefined ? undefined : composerId} data-editor-version={editorVersion}
      data-attachment-drop-zone={composerId} data-attachment-drop-disabled={disabled ? '' : undefined}
      onDragEnter={dragOver} onDragOver={dragOver}
      onDragLeave={event => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDragging(false)
      }}
      onDrop={event => {
        if (isFileDrag(event)) {
          event.preventDefault()
          if (!disabled && event.dataTransfer.files.length) onFiles?.(event.dataTransfer.files)
        }
        setDragging(false)
      }}>
      {children}
      {dragging && !disabled ? <div className="ent-attachment-drop-hint" aria-hidden="true"><Upload size={21} />松开添加附件</div> : null}
    </Surface>
  )
}
