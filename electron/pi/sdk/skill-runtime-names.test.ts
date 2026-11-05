import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { allocateSkillNames, type RuntimeSkillName } from './skill-runtime-names'

describe('runtime skill names', () => {
  it('reserves original names and resolves collisions independently of input order', () => {
    const entries: RuntimeSkillName[] = [
      { id: 'common-office', name: 'officecli', source: 'common' },
      { id: 'employee-office-a', name: 'officecli', source: 'employee' },
      { id: 'employee-office-b', name: 'officecli', source: 'employee' },
      { id: 'existing-prefix', name: 'employee-officecli', source: 'employee' },
    ]
    const names = allocateSkillNames(entries)
    assert.equal(names.get('common-office'), 'officecli')
    assert.equal(names.get('existing-prefix'), 'employee-officecli')
    assert.equal(new Set(names.values()).size, entries.length)
    assert.deepEqual(names, allocateSkillNames([...entries].reverse()))
  })
  it('keeps full names in collision aliases without splitting Unicode characters', () => {
    const entries: RuntimeSkillName[] = [
      { id: 'a', name: 'unique', source: 'employee' },
      { id: 'b', name: '𠀀'.repeat(64), source: 'employee' },
      { id: 'c', name: '𠀀'.repeat(64), source: 'employee' },
    ]
    const names = allocateSkillNames(entries)
    assert.equal(names.get('a'), 'unique')
    for (const value of names.values()) {
      assert.equal(Buffer.from(value).toString('utf8'), value)
    }
    assert.ok(names.get('b')!.includes('𠀀'.repeat(64)))
    assert.ok(names.get('c')!.includes('𠀀'.repeat(64)))
  })
})
