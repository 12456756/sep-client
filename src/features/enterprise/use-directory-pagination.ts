import { useLayoutEffect, useRef, useState } from 'react'
import type { WorkListPagination } from './use-work-list-pagination'
import { parsePageSizeChoice, type PageSizeChoice } from './page-size-choice'
import { directoryPageRanges } from './directory-page-ranges'

interface Options<T> {
  records: T[]
  getId: (record: T) => string
  filterKey: string
  storageKey: string
  rowSelector: string
  layoutKey?: string
  selectedId?: string | null
  disabled?: boolean
}

export function useDirectoryPagination<T>({ records, getId, filterKey, storageKey, rowSelector, layoutKey = '', selectedId = null, disabled = false }: Options<T>): WorkListPagination & { records: T[] } {
  const listRef = useRef<HTMLDivElement>(null)
  const [measurement, setMeasurement] = useState<{
    records: T[]; layoutKey: string; width: number; height: number;
    heights: number[]; available: number; columns: number; gap: number;
  } | null>(null)
  const [pageSizeChoice, setPageSizeChoice] = useState<PageSizeChoice>(() => {
    try { return parsePageSizeChoice(window.localStorage.getItem(storageKey)) ?? 'auto' }
    catch { return 'auto' }
  })
  const selectedIndex = records.findIndex(record => getId(record) === selectedId)
  const selection = selectedIndex < 0 ? null : selectedId
  const [state, setState] = useState({ anchor: Math.max(0, selectedIndex), filterKey, selection })
  let anchor = state.anchor
  if (state.filterKey !== filterKey) anchor = 0
  else if (selection !== null && state.selection !== selection) anchor = selectedIndex
  anchor = Math.max(0, Math.min(anchor, records.length - 1))
  if (anchor !== state.anchor || state.filterKey !== filterKey || state.selection !== selection) {
    setState({ anchor, filterKey, selection })
  }
  const automatic = pageSizeChoice === 'auto'
  const measured = measurement?.layoutKey === layoutKey && measurement.records.length === records.length
    && measurement.records.every((record, index) => record === records[index])
  const measuring = automatic && !measured && records.length > 0
  const fixedSize = automatic ? 5 : Number(pageSizeChoice)
  const pages = automatic && measured
    ? directoryPageRanges(measurement.heights, measurement.available, measurement.columns, measurement.gap)
    : Array.from({ length: Math.max(1, Math.ceil(records.length / fixedSize)) }, (_, index) => ({ start: index * fixedSize, end: Math.min(records.length, (index + 1) * fixedSize) }))
  const page = Math.max(0, pages.findIndex(range => anchor >= range.start && anchor < range.end)) + 1
  const { start, end } = pages[page - 1]
  const pageCount = pages.length
  const pageSize = automatic && measured ? Math.max(1, end - start) : fixedSize
  // Measure actual rows before paint, then display the packed page. No hidden duplicate controls or IDs.
  const visibleRecords = measuring ? records : records.slice(start, end)
  const visibleKeys = JSON.stringify(visibleRecords.map(getId))

  useLayoutEffect(() => {
    const list = listRef.current
    const rows = Array.from(list?.querySelectorAll<HTMLElement>(rowSelector) ?? [])
    if (!list || !rows.length || disabled || !automatic) return
    const measure = () => {
      // Expanded skill content scrolls within its current page without hiding the active row.
      if (!measuring && list.querySelector('details[open], .skill-more-employees[aria-expanded="true"]')) return
      const bounds = list.getBoundingClientRect()
      if (!measuring) {
        // A page's last employee row can lose its bottom border; shrinking must not trigger a measurement loop.
        if (measurement && (Math.abs(measurement.width - bounds.width) > 0.5 || Math.abs(measurement.height - bounds.height) > 0.5
          || rows.some((row, index) => row.getBoundingClientRect().height - measurement.heights[start + index] > 0.5))) setMeasurement(null)
        return
      }
      const first = rows[0].getBoundingClientRect()
      const parent = rows[0].parentElement!
      const style = getComputedStyle(parent)
      const columns = style.display === 'grid' ? style.gridTemplateColumns.split(' ').length : 1
      const gap = Number.parseFloat(style.rowGap) || 0
      const inset = Math.max(0, first.top - bounds.top + list.scrollTop)
      const available = bounds.height - inset - (Number.parseFloat(style.paddingBottom) || 0) - 1
      if (bounds.height > 0) setMeasurement({ records, layoutKey, width: bounds.width, height: bounds.height,
        heights: rows.map(row => row.getBoundingClientRect().height), available, columns, gap })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    if (rows[0].parentElement) observer.observe(rows[0].parentElement)
    rows.forEach(row => observer.observe(row))
    return () => observer.disconnect()
  }, [visibleKeys, rowSelector, layoutKey, disabled, automatic, measuring, measurement, records, start])

  useLayoutEffect(() => { if (listRef.current && !measuring) listRef.current.scrollTop = 0 }, [start, pageSize, filterKey, measuring])

  return {
    listRef, page, pageSize, pageCount, total: records.length, records: visibleRecords, pageSizeChoice,
    onPageSizeChange: value => {
      const choice = parsePageSizeChoice(value)
      if (!choice || disabled) return
      setState(current => ({ ...current, anchor: selectedIndex >= start && selectedIndex < end ? selectedIndex : start }))
      setPageSizeChoice(choice)
      if (choice === 'auto') setMeasurement(null)
      try { window.localStorage.setItem(storageKey, choice) } catch { /* Storage failure must not prevent pagination. */ }
    },
    onPageChange: next => { if (!disabled) setState(current => ({ ...current, anchor: pages[Math.max(1, Math.min(next, pageCount)) - 1].start })) },
  }
}
