import assert from 'node:assert/strict'
import { test } from 'node:test'
import { directoryPageRanges } from './directory-page-ranges'

test('a tall skill row does not prevent a fifth item fitting in the remaining space', () => {
  const heights = [88, 78, 117, 78, 78, 117, 78, 78, 78]
  const pages = directoryPageRanges(heights, 488)
  assert.deepEqual(pages, [{ start: 0, end: 5 }, { start: 5, end: 9 }])
  assert.deepEqual(pages.flatMap(page => heights.slice(page.start, page.end)), heights)
  for (const page of pages) {
    const used = heights.slice(page.start, page.end).reduce((a, b) => a + b, 0)
    assert.ok(used <= 488)
    if (page.end < heights.length) assert.ok(used + heights[page.end] > 488)
  }
})

test('grid pages preserve complete rows and include their gaps', () => {
  assert.deepEqual(directoryPageRanges([90, 110, 95, 80, 75, 100, 70], 220, 3, 10), [
    { start: 0, end: 6 }, { start: 6, end: 7 },
  ])
})

test('exact fits, an oversized row and empty results remain reachable', () => {
  assert.deepEqual(directoryPageRanges([100, 100, 100], 200), [{ start: 0, end: 2 }, { start: 2, end: 3 }])
  assert.deepEqual(directoryPageRanges([300, 50], 200), [{ start: 0, end: 1 }, { start: 1, end: 2 }])
  assert.deepEqual(directoryPageRanges([], 0), [{ start: 0, end: 0 }])
})
