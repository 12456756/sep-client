import React from 'react'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import type { WorkListPagination } from '../../features/enterprise/use-work-list-pagination'
import { IconHint } from './IconHint'
import { PageSizeControl } from './PageSizeControl'

export function ListPagination({ pagination, label, disabled = false }: { pagination: WorkListPagination; label: string; disabled?: boolean }): React.JSX.Element {
  return <nav className="ent-list-pagination" aria-label={label}>
    <div className="ent-list-pagination-summary">
      <span>共 {pagination.total} 项</span>
      <PageSizeControl pageSize={pagination.pageSize} choice={pagination.pageSizeChoice} onChange={pagination.onPageSizeChange} disabled={disabled} />
    </div>
    <div className="ent-list-pagination-controls">
      <IconHint label="第一页" side="top"><button type="button" aria-label="第一页" disabled={disabled || pagination.page === 1} onClick={() => pagination.onPageChange(1)}><ChevronsLeft size={16} aria-hidden /></button></IconHint>
      <IconHint label="上一页" side="top"><button type="button" aria-label="上一页" disabled={disabled || pagination.page === 1} onClick={() => pagination.onPageChange(pagination.page - 1)}><ChevronLeft size={16} aria-hidden /></button></IconHint>
      <span role="status" aria-live="polite" aria-atomic="true">{pagination.page} / {pagination.pageCount}</span>
      <IconHint label="下一页" side="top"><button type="button" aria-label="下一页" disabled={disabled || pagination.page === pagination.pageCount} onClick={() => pagination.onPageChange(pagination.page + 1)}><ChevronRight size={16} aria-hidden /></button></IconHint>
      <IconHint label="最后一页" side="top"><button type="button" aria-label="最后一页" disabled={disabled || pagination.page === pagination.pageCount} onClick={() => pagination.onPageChange(pagination.pageCount)}><ChevronsRight size={16} aria-hidden /></button></IconHint>
    </div>
  </nav>
}
