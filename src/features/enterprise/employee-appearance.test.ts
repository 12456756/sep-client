import assert from 'node:assert/strict';
import { it } from 'node:test';
import { employeeAppearance } from './employee-appearance';

it('new employees receive a complete appearance without a configured portrait', () => {
  for (const id of ['', 'new-subscription', '员工-新增-一', 'employee:with/slashes']) {
    const appearance = employeeAppearance(id);
    assert.ok(['rounded', 'capsule', 'squircle'].includes(appearance.shell));
    assert.ok(['wide', 'compact', 'arched'].includes(appearance.visor));
    assert.ok(['left', 'right', 'both'].includes(appearance.ear));
    assert.ok(['bar', 'round', 'diamond'].includes(appearance.core));
    assert.ok(['coral', 'sage', 'sky', 'amber', 'lilac', 'teal', 'rose', 'peach', 'slate', 'silver'].includes(appearance.palette));
    assert.ok(['friendly', 'cheerful', 'curious', 'calm', 'bright'].includes(appearance.expression));
    assert.deepEqual(employeeAppearance(id), appearance);
  }
});

it('appearance is independent of directory order and supports varied combinations', () => {
  const ids = Array.from({ length: 60 }, (_, index) => `employee-${index + 1}`);
  const originals = new Map(ids.map(id => [id, employeeAppearance(id)]));
  for (const id of ids.reverse()) assert.deepEqual(employeeAppearance(id), originals.get(id));
  assert.equal(new Set([...originals.values()].map(item => item.shell)).size, 3);
  assert.equal(new Set([...originals.values()].map(item => item.visor)).size, 3);
  assert.equal(new Set([...originals.values()].map(item => item.ear)).size, 3);
  assert.equal(new Set([...originals.values()].map(item => item.core)).size, 3);
  assert.equal(new Set([...originals.values()].map(item => item.palette)).size, 10);
  assert.equal(new Set([...originals.values()].map(item => item.expression)).size, 5);
  assert.ok(new Set([...originals.values()].map(item => JSON.stringify(item))).size >= 30);
});
