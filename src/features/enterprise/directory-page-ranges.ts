export interface DirectoryPageRange {
  start: number
  end: number
}

/** Pack complete grid rows (or individual list entries) without estimating every item from the tallest. */
export function directoryPageRanges(heights: readonly number[], availableHeight: number, columns = 1, gap = 0): DirectoryPageRange[] {
  const pages: DirectoryPageRange[] = []
  let start = 0
  let used = 0
  for (let index = 0; index < heights.length; index += columns) {
    const height = Math.max(...heights.slice(index, index + columns))
    const spacing = index > start ? gap : 0
    if (index > start && used + spacing + height > availableHeight + 0.5) {
      pages.push({ start, end: index })
      start = index
      used = height
    } else used += spacing + height
  }
  if (start < heights.length) pages.push({ start, end: heights.length })
  return pages.length ? pages : [{ start: 0, end: 0 }]
}
