import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createHomePreview } from './home-preview';

it('keeps only the requested number of entries and reports the remainder', () => {
  assert.deepEqual(createHomePreview(['a', 'b', 'c', 'd'], 3), {
    items: ['a', 'b', 'c'],
    remaining: 1,
  });
});

it('reports no remainder when all entries fit', () => {
  assert.deepEqual(createHomePreview(['a', 'b'], 4), {
    items: ['a', 'b'],
    remaining: 0,
  });
});

it('handles an empty collection and a zero preview limit', () => {
  assert.deepEqual(createHomePreview([], 4), { items: [], remaining: 0 });
  assert.deepEqual(createHomePreview(['a'], 0), { items: [], remaining: 1 });
});
