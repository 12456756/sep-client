import * as assert from 'node:assert/strict'
import { access, chmod, mkdtemp, mkdir, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SkillImportFiles } from './skill-import-files'

async function fixture(): Promise<{ base: string; home: string; project: string; temp: string; files: SkillImportFiles }> {
  const base = await mkdtemp(join(tmpdir(), 'sep-skill-import-'))
  const home = join(base, 'home')
  const project = join(base, 'project')
  const temp = join(base, 'temp')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  return { base, home, project, temp, files: new SkillImportFiles({ homeDir: home, tempDir: temp }) }
}

async function addSkill(root: string, name = 'weekly-report'): Promise<string> {
  const directory = join(root, name)
  await mkdir(join(directory, 'references'), { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), '---\nname: 周报助手\ndescription: |\n  汇总中文周报\n  并生成行动项\n---\n# 步骤\n')
  await writeFile(join(directory, 'references', '样例.md'), '示例内容')
  return directory
}

function agentsRoot(files: SkillImportFiles): Promise<{ id: string }> {
  return files.listRoots().then(roots => {
    const root = roots.find(item => item.path.endsWith('/.agents/skills'))
    assert.ok(root)
    return root
  })
}

test('scans authorized root, previews YAML metadata, and packages a Chinese UTF-8 ZIP', async () => {
  const f = await fixture()
  const skills = join(f.home, '.agents', 'skills')
  const skill = await addSkill(skills)
  const root = await agentsRoot(f.files)
  const candidates = await f.files.scan([root.id])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.description, '汇总中文周报\n并生成行动项')
  const preview = await f.files.preview({ requestId: 'req-1', candidateId: candidates[0]!.candidateId, revision: 1 })
  assert.equal(preview.content.includes('# 步骤'), true)
  assert.deepEqual(preview.files.map(file => file.relativePath), ['references/样例.md', 'SKILL.md'])
  const archive = await f.files.packageSelected({ candidateId: candidates[0]!.candidateId, snapshotId: preview.snapshotId, operationId: 'op-1' })
  const chunks: Buffer[] = []
  for await (const chunk of archive.open()) chunks.push(Buffer.from(chunk))
  const zip = Buffer.concat(chunks)
  const entries = new Map<string, Buffer>()
  let zipOffset = 0
  while (zip.readUInt32LE(zipOffset) === 0x04034b50) {
    const nameLength = zip.readUInt16LE(zipOffset + 26)
    const extraLength = zip.readUInt16LE(zipOffset + 28)
    const entrySize = zip.readUInt32LE(zipOffset + 22)
    const name = zip.subarray(zipOffset + 30, zipOffset + 30 + nameLength).toString('utf8')
    entries.set(name, zip.subarray(zipOffset + 30 + nameLength + extraLength, zipOffset + 30 + nameLength + extraLength + entrySize))
    zipOffset += 30 + nameLength + extraLength + entrySize
  }
  assert.equal(entries.get('references/样例.md')?.toString('utf8'), '示例内容')
  assert.match(archive.sha256, /^[0-9a-f]{64}$/)
  await f.files.dispose()
  await rm(f.base, { recursive: true, force: true })
  void skill
})

test('discovers malformed metadata with a directory-name fallback', async () => {
  const f = await fixture()
  const skills = join(f.home, '.agents', 'skills')
  const skill = join(skills, 'fallback-skill')
  await mkdir(skill, { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), '# no frontmatter\n')
  const root = await agentsRoot(f.files)
  const [candidate] = await f.files.scan([root.id])
  assert.ok(candidate)
  assert.equal(candidate.name, 'fallback-skill')
  assert.ok(candidate.warnings.some(warning => warning.code === 'METADATA_NORMALIZED'))
  const preview = await f.files.preview({ requestId: 'req-fallback', candidateId: candidate.candidateId, revision: 1 })
  assert.ok(preview.warnings.some(warning => warning.code === 'METADATA_NORMALIZED'))
  await f.files.dispose()
  await rm(f.base, { recursive: true, force: true })
})

test('preserves lowercase skill.md identity through preview and packaging', async () => {
  const f = await fixture()
  const skills = join(f.home, '.agents', 'skills')
  const skill = join(skills, 'lowercase-entry')
  await mkdir(skill, { recursive: true })
  await writeFile(join(skill, 'skill.md'), '---\nname: Lowercase\n---\ncontent\n')
  const root = await agentsRoot(f.files)
  const [candidate] = await f.files.scan([root.id])
  assert.ok(candidate)
  const preview = await f.files.preview({ requestId: 'req-lower', candidateId: candidate.candidateId, revision: 1 })
  assert.ok(preview.files.some(file => file.relativePath === 'skill.md'))
  await f.files.packageSelected({ candidateId: candidate.candidateId, snapshotId: preview.snapshotId, operationId: 'op-lower' })
  await f.files.dispose()
  await rm(f.base, { recursive: true, force: true })
})

test('reports excluded resource directories in preview warnings', async () => {
  const f = await fixture()
  const skills = join(f.home, '.agents', 'skills')
  const skill = await addSkill(skills, 'excluded-resources')
  await mkdir(join(skill, '.git', 'objects'), { recursive: true })
  await writeFile(join(skill, '.git', 'objects', 'ignored'), 'ignored')
  const root = await agentsRoot(f.files)
  const [candidate] = await f.files.scan([root.id])
  assert.ok(candidate)
  const preview = await f.files.preview({ requestId: 'req-excluded', candidateId: candidate.candidateId, revision: 1 })
  assert.ok(preview.warnings.some(warning => warning.code === 'RESOURCE_DIRECTORY_EXCLUDED'))
  await f.files.dispose()
  await rm(f.base, { recursive: true, force: true })
})

test('rejects secret files without exposing their contents', async () => {
  const f = await fixture()
  const skills = join(f.home, '.agents', 'skills')
  const skill = await addSkill(skills)
  await writeFile(join(skill, '.env'), 'private-api-secret-value')
  const root = await agentsRoot(f.files)
  const [candidate] = await f.files.scan([root.id])
  assert.ok(candidate)
  await assert.rejects(f.files.preview({ requestId: 'req-secret', candidateId: candidate.candidateId, revision: 1 }), /SECRET_FILE_BLOCKED/)
  assert.deepEqual(f.files.getScanWarnings(), [])
  assert.equal(JSON.stringify(f.files.getScanWarnings()).includes('private-api-secret-value'), false)
  await f.files.dispose()
  await rm(f.base, { recursive: true, force: true })
})

test('does not follow symlinks outside approved roots', async () => {
  const f = await fixture()
  const skills = join(f.home, '.agents', 'skills')
  await mkdir(skills, { recursive: true })
  const outside = await addSkill(f.project, 'outside')
  await symlink(outside, join(skills, 'escape'))
  const root = await agentsRoot(f.files)
  assert.deepEqual(await f.files.scan([root.id]), [])
  await f.files.dispose()
  await rm(f.base, { recursive: true, force: true })
})

test('includes safe hidden resources and preserves authorized in-root symlink names', async () => {
  const f = await fixture()
  const skills = join(f.home, '.agents', 'skills')
  const skill = await addSkill(skills)
  await writeFile(join(skill, '.env.example'), 'API_URL=https://example.invalid')
  await mkdir(join(skill, 'shared'), { recursive: true })
  await writeFile(join(skill, 'shared', 'guide.md'), 'shared guide')
  await symlink(join(skill, 'references', '样例.md'), join(skill, 'linked-file.md'))
  await symlink(join(skill, 'shared'), join(skill, 'linked-dir'), 'dir')
  const root = await agentsRoot(f.files)
  const [candidate] = await f.files.scan([root.id])
  assert.ok(candidate)
  const preview = await f.files.preview({ requestId: 'req-links', candidateId: candidate.candidateId, revision: 1 })
  const paths = preview.files.map(file => file.relativePath)
  assert.ok(paths.includes('.env.example'))
  assert.ok(paths.includes('linked-file.md'))
  assert.ok(paths.includes('linked-dir/guide.md'))
  const archive = await f.files.packageSelected({ candidateId: candidate.candidateId, snapshotId: preview.snapshotId, operationId: 'op-links' })
  const chunks: Buffer[] = []
  for await (const chunk of archive.open()) chunks.push(Buffer.from(chunk))
  const zip = Buffer.concat(chunks)
  const names: string[] = []
  let offset = 0
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const nameLength = zip.readUInt16LE(offset + 26)
    const extraLength = zip.readUInt16LE(offset + 28)
    const size = zip.readUInt32LE(offset + 22)
    names.push(zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'))
    offset += 30 + nameLength + extraLength + size
  }
  assert.ok(names.includes('linked-file.md'))
  assert.ok(names.includes('linked-dir/guide.md'))
  await f.files.dispose()
  await rm(f.base, { recursive: true, force: true })
})

test('blocks a harmlessly named symlink to a secret file', async () => {
  const f = await fixture()
  const skills = join(f.home, '.agents', 'skills')
  const skill = await addSkill(skills)
  await writeFile(join(skill, '.env'), 'do-not-export-this-secret')
  await symlink(join(skill, '.env'), join(skill, 'reference.txt'))
  const root = await agentsRoot(f.files)
  const [candidate] = await f.files.scan([root.id])
  assert.ok(candidate)
  await assert.rejects(
    f.files.preview({ requestId: 'req-secret-link', candidateId: candidate.candidateId, revision: 1 }),
    /SECRET_FILE_BLOCKED/,
  )
  await f.files.dispose()
  await rm(f.base, { recursive: true, force: true })
})

test('preserves empty directories and invalidates their snapshot when changed', async () => {
  const f = await fixture()
  const skills = join(f.home, '.agents', 'skills')
  const skill = await addSkill(skills)
  await mkdir(join(skill, 'empty-dir'), { recursive: true })
  const root = await agentsRoot(f.files)
  const [candidate] = await f.files.scan([root.id])
  assert.ok(candidate)
  const preview = await f.files.preview({ requestId: 'req-empty', candidateId: candidate.candidateId, revision: 1 })
  assert.ok(preview.estimatedPackageBytes > preview.totalUncompressedBytes)
  const archive = await f.files.packageSelected({ candidateId: candidate.candidateId, snapshotId: preview.snapshotId, operationId: 'op-empty' })
  const chunks: Buffer[] = []
  for await (const chunk of archive.open()) chunks.push(Buffer.from(chunk))
  const zip = Buffer.concat(chunks)
  let offset = 0
  const names: string[] = []
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const nameLength = zip.readUInt16LE(offset + 26)
    const extraLength = zip.readUInt16LE(offset + 28)
    const size = zip.readUInt32LE(offset + 22)
    names.push(zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'))
    offset += 30 + nameLength + extraLength + size
  }
  assert.ok(names.includes('empty-dir/'))
  await mkdir(join(skill, 'empty-dir', 'nested'), { recursive: true })
  await assert.rejects(f.files.packageSelected({ candidateId: candidate.candidateId, snapshotId: preview.snapshotId, operationId: 'op-empty-changed' }), /CANDIDATE_CHANGED/)
  await f.files.dispose()
  await rm(f.base, { recursive: true, force: true })
})

test('invalidates a preview snapshot when a candidate file changes', async () => {
  const f = await fixture()
  const skills = join(f.home, '.agents', 'skills')
  const skill = await addSkill(skills)
  const root = await agentsRoot(f.files)
  const [candidate] = await f.files.scan([root.id])
  const preview = await f.files.preview({ requestId: 'req-1', candidateId: candidate!.candidateId, revision: 1 })
  await writeFile(join(skill, 'references', '样例.md'), 'changed content')
  await assert.rejects(f.files.packageSelected({ candidateId: candidate!.candidateId, snapshotId: preview.snapshotId, operationId: 'op-1' }), /CANDIDATE_CHANGED/)
  await f.files.dispose()
  await rm(f.base, { recursive: true, force: true })
})

test('honors cancellation before walking an authorized root', async () => {
  const f = await fixture()
  const skills = join(f.home, '.agents', 'skills')
  await addSkill(skills)
  const root = await agentsRoot(f.files)
  const controller = new AbortController()
  controller.abort(new Error('IMPORT_CANCELLED'))
  await assert.rejects(f.files.scan([root.id], { signal: controller.signal }), /IMPORT_CANCELLED/)
  await f.files.dispose()
  await rm(f.base, { recursive: true, force: true })
})

test('keeps project roots and remembers removed user roots', async () => {
  const f = await fixture()
  const skills = join(f.home, '.agents', 'skills')
  await mkdir(skills, { recursive: true })
  const userRoot = await agentsRoot(f.files)
  await f.files.removeRoot(userRoot.id)
  assert.equal((await f.files.listRoots()).some(root => root.id === userRoot.id), false)
  const projectRoot = await f.files.addProjectRoot(f.project)
  assert.equal((await f.files.listRoots()).some(root => root.id === projectRoot.id), true)
  await f.files.dispose()
  await rm(f.base, { recursive: true, force: true })
})

test('initialize removes only expired generated archives', async () => {
  const f = await fixture()
  await mkdir(f.temp, { recursive: true })
  const oldZip = join(f.temp, 'skill-import-old.zip')
  const newZip = join(f.temp, 'skill-import-new.zip')
  const note = join(f.temp, 'keep.txt')
  await writeFile(oldZip, 'old')
  await writeFile(newZip, 'new')
  await writeFile(note, 'keep')
  const old = new Date(Date.now() - 2 * 60 * 60_000)
  await utimes(oldZip, old, old)
  await f.files.initialize()
  await assert.rejects(access(oldZip))
  await access(newZip)
  await access(note)
  await f.files.dispose()
  await rm(f.base, { recursive: true, force: true })
})

test('deduplicates canonical user roots while retaining source labels', async () => {
  const f = await fixture()
  const agents = join(f.home, '.agents', 'skills')
  await mkdir(agents, { recursive: true })
  await symlink(agents, join(f.home, '.codex', 'skills')).catch(async error => {
    if (error?.code !== 'ENOENT') throw error
    await mkdir(join(f.home, '.codex'), { recursive: true })
    await symlink(agents, join(f.home, '.codex', 'skills'))
  })
  const roots = await f.files.listRoots()
  const aliases = roots.filter(root => root.path.endsWith('/.agents/skills') || root.path.endsWith('/.codex/skills'))
  assert.equal(aliases.length, 1)
  assert.ok(aliases.some(root => root.sources.includes('agents') && root.sources.includes('codex')))
  await f.files.dispose()
  await rm(f.base, { recursive: true, force: true })
})

test('cancelling an active package removes its temporary archive', async () => {
  const f = await fixture()
  const skills = join(f.home, '.agents', 'skills')
  const skill = await addSkill(skills)
  await writeFile(join(skill, 'references', 'large.bin'), Buffer.alloc(32 * 1024 * 1024, 7))
  const root = await agentsRoot(f.files)
  const [candidate] = await f.files.scan([root.id])
  assert.ok(candidate)
  const preview = await f.files.preview({ requestId: 'req-cancel-package', candidateId: candidate.candidateId, revision: 1 })
  const controller = new AbortController()
  const packaging = f.files.packageSelected({ candidateId: candidate.candidateId, snapshotId: preview.snapshotId, operationId: 'op-cancel-package' }, controller.signal)
  const deadline = Date.now() + 5_000
  let seenArchive = false
  while (Date.now() < deadline) {
    const names = await readdir(f.temp).catch(() => [])
    if (names.some(name => name.startsWith('skill-import-') && name.endsWith('.zip'))) { seenArchive = true; controller.abort(new Error('IMPORT_CANCELLED')); break }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  if (!seenArchive) controller.abort(new Error('IMPORT_CANCELLED'))
  assert.equal(seenArchive, true, 'must cancel after ZIP writer opens')
  await assert.rejects(packaging, error => error instanceof Error && (
    error.message === 'IMPORT_CANCELLED' || (error.name === 'AbortError' && error.cause instanceof Error && error.cause.message === 'IMPORT_CANCELLED')
  ))
  assert.deepEqual((await readdir(f.temp).catch(() => [])).filter(name => name.endsWith('.zip')), [])
  await f.files.dispose()
  await rm(f.base, { recursive: true, force: true })
})

test('reports unwritable package directory without unhandled writer rejection', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('filesystem permissions are not enforced for this test user'); return }
  const f = await fixture()
  const skills = join(f.home, '.agents', 'skills')
  await addSkill(skills)
  const root = await agentsRoot(f.files)
  const [candidate] = await f.files.scan([root.id])
  assert.ok(candidate)
  const preview = await f.files.preview({ requestId: 'req-eacces', candidateId: candidate.candidateId, revision: 1 })
  await mkdir(f.temp, { recursive: true })
  await chmod(f.temp, 0o500)
  try {
    await assert.rejects(
      f.files.packageSelected({ candidateId: candidate.candidateId, snapshotId: preview.snapshotId, operationId: 'op-eacces' }),
      error => error instanceof Error && ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''),
    )
  } finally {
    await chmod(f.temp, 0o700)
    await f.files.dispose()
    await rm(f.base, { recursive: true, force: true })
  }
})
