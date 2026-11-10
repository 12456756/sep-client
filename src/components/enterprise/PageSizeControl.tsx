import React from 'react'
import type { PageSizeChoice } from '../../features/enterprise/page-size-choice'

interface Props {
  pageSize: number
  choice: PageSizeChoice
  onChange: (value: string) => void
  disabled?: boolean
}

export function PageSizeControl({ pageSize, choice, onChange, disabled = false }: Props): React.JSX.Element {
  return <div className="ent-page-size-controls">
    <label className="ent-page-size-label">每页<input key={`${choice}:${pageSize}`} type="number" className="ent-page-size-input" aria-label="每页项数" min={1} max={Number.MAX_SAFE_INTEGER} step={1} defaultValue={pageSize} disabled={disabled}
      onBlur={event => {
        const input = event.currentTarget
        if (input.validity.valid && Number.isSafeInteger(input.valueAsNumber) && input.valueAsNumber > 0) {
          if (input.value !== String(pageSize)) onChange(input.value)
          input.value = String(input.valueAsNumber)
        } else input.value = String(pageSize)
      }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); if (event.currentTarget.reportValidity()) event.currentTarget.blur() }
        if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.value = String(pageSize); event.currentTarget.blur() }
      }} />项</label>
    <label className="ent-page-size-auto"><input type="checkbox" checked={choice === 'auto'} disabled={disabled} onChange={event => onChange(event.target.checked ? 'auto' : String(pageSize))} />自动</label>
  </div>
}
