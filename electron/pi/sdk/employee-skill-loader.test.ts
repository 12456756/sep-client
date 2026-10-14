import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent'
import { employeeSkillLoaderOptions } from './employee-skill-loader'

const approvedContent = '---\nname: orders\ndescription: Approved orders\n---\nApproved operations.\n'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sep-employee-loader-'))
  const cwd = join(root, 'workspace')
  const agentDir = join(root, 'agent')
  const approved = join(root, 'approved', 'orders')
  const home = process.env.HOME
  process.env.HOME = join(root, 'home')
  async function skill(path: string, content = approvedContent) {
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'SKILL.md'), content)
  }
  await mkdir(cwd, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await skill(approved)
  function loader(paths: string[] | undefined = [approved]) {
    return new DefaultResourceLoader({
      cwd, agentDir,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      additionalSkillPaths: paths,
      ...employeeSkillLoaderOptions(cwd, agentDir, paths),
    })
  }
  return {
    cwd, agentDir, approved, skill, loader,
    async cleanup() {
      if (home === undefined) delete process.env.HOME
      else process.env.HOME = home
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe('employee skills with the real DefaultResourceLoader (no model)', () => {
  it('loads only the prepared entry despite project and user same-name skills', async t => {
    const f = await fixture()
    t.after(f.cleanup)
    await f.skill(join(f.cwd, '.pi', 'skills', 'orders'), approvedContent.replace('Approved operations.', 'Project override.'))
    await f.skill(join(f.agentDir, 'skills', 'orders'), approvedContent.replace('Approved operations.', 'User override.'))
    await f.skill(join(process.env.HOME!, '.agents', 'skills', 'orders'), approvedContent.replace('Approved operations.', 'Global override.'))
    await f.skill(join(f.cwd, '.pi', 'skills', 'extra'), approvedContent.replace('name: orders', 'name: extra'))
    const loader = f.loader()
    await loader.reload()
    const loaded = loader.getSkills()
    assert.deepEqual(loaded.diagnostics, [])
    assert.deepEqual(loaded.skills.map(skill => skill.filePath), [join(f.approved, 'SKILL.md')])
    assert.equal(createHash('sha256').update(await readFile(loaded.skills[0].filePath)).digest('hex'),
      createHash('sha256').update(approvedContent).digest('hex'))
    await loader.reload()
    assert.equal(loader.getSkills().skills[0].filePath, join(f.approved, 'SKILL.md'))
  })

  it('keeps empty employee skill sets empty instead of discovering workstation skills', async t => {
    const f = await fixture()
    t.after(f.cleanup)
    await f.skill(join(f.cwd, '.pi', 'skills', 'orders'))
    const loader = f.loader([])
    await loader.reload()
    assert.deepEqual(loader.getSkills().skills, [])
  })

  it('preserves ordinary session discovery and explicit skill paths', async t => {
    const f = await fixture()
    t.after(f.cleanup)
    const project = join(f.cwd, '.pi', 'skills', 'orders')
    await f.skill(project)
    const loader = new DefaultResourceLoader({
      cwd: f.cwd, agentDir: f.agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      additionalSkillPaths: [f.approved],
      ...employeeSkillLoaderOptions(f.cwd, f.agentDir, undefined),
    })
    await loader.reload()
    assert.equal(loader.getSkills().skills[0].filePath, join(project, 'SKILL.md'))
    assert.ok(loader.getSkills().diagnostics.some(diagnostic => diagnostic.type === 'collision'))
  })

  it('fails closed on missing and duplicate prepared paths and duplicate names', async t => {
    const f = await fixture()
    t.after(f.cleanup)
    assert.throws(() => f.loader([join(f.cwd, 'missing')]), /integrity mismatch/)
    assert.throws(() => f.loader([f.approved, f.approved]), /integrity mismatch/)
    const duplicate = join(f.agentDir, 'orders')
    await f.skill(duplicate)
    assert.throws(() => f.loader([f.approved, duplicate]), /integrity mismatch/)
  })

  it('rejects body-only byte changes before the first reload and on later reloads', async t => {
    const f = await fixture()
    t.after(f.cleanup)
    const before = f.loader()
    const later = f.loader()
    await later.reload()
    await f.skill(f.approved, approvedContent.replace('Approved operations.', 'Changed operations.'))
    await assert.rejects(before.reload(), /integrity mismatch/)
    await assert.rejects(later.reload(), /integrity mismatch/)
    await rm(join(f.approved, 'SKILL.md'))
    await assert.rejects(later.reload(), /integrity mismatch/)
  })

  it('rejects unexpected skills added through extendResources', async t => {
    const f = await fixture()
    t.after(f.cleanup)
    const extra = join(f.cwd, 'extra')
    await f.skill(extra, approvedContent.replace('name: orders', 'name: extra'))
    const loader = f.loader()
    await loader.reload()
    assert.throws(() => loader.extendResources({
      skillPaths: [{ path: extra, metadata: { source: 'local', scope: 'project', origin: 'top-level' } }],
    }), /integrity mismatch/)
  })

  it('accepts exact CRLF bytes and multiple prepared entries, including owner-local content', async t => {
    const f = await fixture()
    t.after(f.cleanup)
    const local = join(f.agentDir, 'local-orders')
    const content = approvedContent.replace('name: orders', 'name: local-orders').replace(/\n/g, '\r\n')
    await f.skill(local, content)
    const loader = f.loader([f.approved, local])
    await loader.reload()
    assert.deepEqual(loader.getSkills().skills.map(skill => skill.filePath),
      [join(f.approved, 'SKILL.md'), join(local, 'SKILL.md')])
    assert.equal(await readFile(join(local, 'SKILL.md'), 'utf8'), content)
  })

})
