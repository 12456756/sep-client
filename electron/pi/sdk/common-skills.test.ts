import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { prepareCommonSkills, OFFICE_SKILL_SHA256 } from './common-skills'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

describe('bundled common skills', () => {
  it('pins the exact checked-in common skill bytes', async () => {
    const bytes = await readFile(resolve('resources/common-skills/officecli/SKILL.md'))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), OFFICE_SKILL_SHA256)
  })
  it('does not fail unrelated tasks when the platform or resources are unavailable', () => {
    assert.equal(prepareCommonSkills('missing', 'darwin', 'ia32').skills.length, 0)
    const result = prepareCommonSkills('missing', 'win32', 'x64')
    assert.equal(result.office, undefined)
    assert.equal(result.unavailable.length, 1)
  })
  it('rejects executable substitution even when the skill entry is genuine', async t => {
    const root = await mkdtemp(join(tmpdir(), 'sep-common-skills-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, 'common-skills/officecli'), { recursive: true })
    await mkdir(join(root, 'office'))
    await copyFile(resolve('resources/common-skills/officecli/SKILL.md'), join(root, 'common-skills/officecli/SKILL.md'))
    await writeFile(join(root, 'office/officecli-win-x64.exe'), 'fake')
    const result = prepareCommonSkills(root, 'win32', 'x64')
    assert.equal(result.skills.length, 0)
    assert.match(result.unavailable[0], /checksum/)
  })
})
