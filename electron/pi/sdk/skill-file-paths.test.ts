import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { win32 } from 'node:path'
import { assertSkillFilePaths } from './skill-file-paths'
import { AppError } from '../../errors/app-error'
import { toEnvelope } from '../../errors/error-mapper'
import { readSkillZip } from './skill-package-zip'
import { zipFixture, zipDescriptor } from './skill-package-zip.fixture'

describe('skill file path preflight', () => {
  it('accepts Windows paths beyond MAX_PATH while enforcing the extended path budget', () => {
    assert.doesNotThrow(() => assertSkillFilePaths(['C:\\cache'], [`${'a'.repeat(200)}/${'b'.repeat(200)}/SKILL.md`], 'win32'))
    const path = `${Array.from({ length: 130 }, () => 'd'.repeat(250)).join('/')}/SKILL.md`
    assert.doesNotThrow(() => assertSkillFilePaths(['C:\\cache'], [path], 'win32'))
    assert.throws(() => assertSkillFilePaths(['C:\\cache'], [`${path}/${'d'.repeat(200)}/file.md`], 'win32'), { code: 'SKILL_PATH_UNSUPPORTED' })
  })

  it('reports the longest complete final or staging path and sanitizes user feedback', () => {
    const root = 'C:\\private-cache'
    const path = `${Array.from({ length: 132 }, () => 'd'.repeat(250)).join('/')}/private-guide.md`
    assert.throws(() => assertSkillFilePaths([root, `${root}\\.staging-XXXXXX`], ['SKILL.md', path], 'win32'), error => {
      assert.ok(error instanceof AppError)
      assert.equal(error.details?.relativePath, path)
      assert.equal(error.details?.pathLength, win32.toNamespacedPath(win32.resolve(root, '.staging-XXXXXX', path)).length)
      const feedback = toEnvelope(error)
      assert.equal(feedback.code, 'SKILL_PATH_UNSUPPORTED')
      assert.match(feedback.message, /目录层级/)
      assert.doesNotMatch(JSON.stringify(feedback), /private|staging|C:/)
      assert.equal(feedback.retryable, undefined)
      return true
    })
  })

  it('counts Windows components in UTF-16 units and POSIX components in UTF-8 bytes', () => {
    assert.doesNotThrow(() => assertSkillFilePaths(['C:\\cache'], ['中'.repeat(255)], 'win32'))
    assert.throws(() => assertSkillFilePaths(['C:\\cache'], ['中'.repeat(256)], 'win32'), { code: 'SKILL_PATH_UNSUPPORTED' })
    assert.throws(() => assertSkillFilePaths(['C:\\cache'], ['𠮷'.repeat(128)], 'win32'), { code: 'SKILL_PATH_UNSUPPORTED' })
    assert.doesNotThrow(() => assertSkillFilePaths(['/cache'], ['中'.repeat(85)], 'linux'))
    assert.throws(() => assertSkillFilePaths(['/cache'], ['中'.repeat(86)], 'linux'), { code: 'SKILL_PATH_UNSUPPORTED' })
    assert.throws(() => assertSkillFilePaths([`C:\\${'u'.repeat(256)}`], ['SKILL.md'], 'win32'), { code: 'SKILL_PATH_UNSUPPORTED' })
  })

  it('checks POSIX full-path limits including generated manifests', () => {
    const path = Array.from({ length: 20 }, () => 'd'.repeat(200)).join('/')
    assert.doesNotThrow(() => assertSkillFilePaths(['/cache'], [`${path}/SKILL.md`], 'linux'))
    assert.throws(() => assertSkillFilePaths(['/cache'], [`${path}/${'d'.repeat(100)}/SKILL.md`], 'linux'), { code: 'SKILL_PATH_UNSUPPORTED' })
    assert.throws(() => assertSkillFilePaths(['/cache'], [`${path}/manifest.json`], 'darwin'), { code: 'SKILL_PATH_UNSUPPORTED' })
  })

  it('checks the complete ZIP inventory before inflating any entry', () => {
    const files = [{ path: 'SKILL.md', bytes: Buffer.from('---\nname: orders\ndescription: Orders\n---\n# Approved') },
      { path: `${'a'.repeat(256)}.md`, bytes: Buffer.from('guide') }]
    const bytes = zipFixture(files, { deflate: true })
    // Corrupt the first compressed stream; preflight must reject the later path first.
    const firstData = 30 + Buffer.byteLength('SKILL.md')
    bytes.fill(0xff, firstData, firstData + 3)
    const artifact = zipDescriptor(bytes, files)
    assert.throws(() => readSkillZip(bytes, artifact, paths => assertSkillFilePaths(['C:\\cache'], paths, 'win32')), { code: 'SKILL_PATH_UNSUPPORTED' })
  })
})
