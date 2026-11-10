import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { WorkItem } from './types'
import type { WorkRecordFilterState } from './work-record-filters'

export interface WorkListPagination {
  listRef: RefObject<HTMLDivElement>
  page: number
  pageSize: number
  pageCount: number
  total: number
  onPageChange: (page: number) => void
}

export function useWorkListPagination(records: WorkItem[], filters: WorkRecordFilterState, selectedWorkId: string | null, listOpen: boolean): WorkListPagination & { records: WorkItem[] } {
  const listRef = useRef<HTMLDivElement>(null)
  const [pageSize, setPageSize] = useState(5)
  const filterKey = JSON.stringify([filters.bucket, filters.workType, filters.search])
  const selectedIndex = records.findIndex(work => work.id === selectedWorkId)
  const selection = selectedIndex < 0 ? null : selectedWorkId
  const [state, setState] = useState({ page: Math.floor(Math.max(0, selectedIndex) / pageSize) + 1, pageSize, filterKey, selection, listOpen })
  const pageCount = Math.max(1, Math.ceil(records.length / pageSize))
  let page = state.page
  if (state.filterKey !== filterKey) page = 1
  else if (selection !== null && (state.selection !== selection || (!state.listOpen && listOpen))) page = Math.floor(selectedIndex / pageSize) + 1
  else if (state.pageSize !== pageSize) {
    const start = (state.page - 1) * state.pageSize
    const anchor = selectedIndex >= start && selectedIndex < start + state.pageSize ? selectedIndex : start
    page = Math.floor(anchor / pageSize) + 1
  }
  page = Math.max(1, Math.min(page, pageCount))
  if (page !== state.page || state.pageSize !== pageSize || state.filterKey !== filterKey || state.selection !== selection || state.listOpen !== listOpen) {
    setState({ page, pageSize, filterKey, selection, listOpen })
  }
  const visibleRecords = records.slice((page - 1) * pageSize, page * pageSize)
  const firstKey = visibleRecords[0]?.recordKey ?? visibleRecords[0]?.id

  useLayoutEffect(() => {
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>('.ent-work-row-wrap')
    if (!list || !row) return
    const measure = () => {
      // Both rectangles include the same display scale; the footer is outside the list.
      const height = list.getBoundingClientRect().height
      const rowHeight = row.getBoundingClientRect().height
      if (height > 0 && rowHeight > 0) setPageSize(Math.max(1, Math.floor(height / rowHeight)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    observer.observe(row)
    return () => observer.disconnect()
  }, [listOpen, firstKey])

  useLayoutEffect(() => { if (listRef.current) listRef.current.scrollTop = 0 }, [page, pageSize, filterKey])

  return {
    listRef, page, pageSize, pageCount, total: records.length, records: visibleRecords,
    onPageChange: next => setState(current => ({ ...current, page: Math.max(1, Math.min(next, pageCount)) })),
  }
}
