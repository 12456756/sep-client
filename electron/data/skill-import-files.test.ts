import * as assert from 'node:assert/strict'
import { access, chmod, mkdtemp, mkdir, open, readdir, realpath, rename, rm, symlink, utimes, writeFile, type FileHandle } from 'node:fs/promises'
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

test('discovers and packages deep skills beyond the former entry size quota', async () => {
  const f = await fixture()
  try {
    const root = await f.files.addProjectRoot(f.project)
    const directory = await addSkill(join(f.project, ...Array.from({ length: 8 }, () => 'nested')))
    await writeFile(join(directory, 'SKILL.md'), '# Large skill\n' + 'x'.repeat(2 * 1024 * 1024 + 1))
    const resources = join(directory, ...Array.from({ length: 8 }, () => 'resources'))
    await mkdir(resources, { recursive: true })
    await writeFile(join(resources, 'data.txt'), 'resource')
    const [candidate] = await f.files.scan([root.id])
    assert.ok(candidate)
    const preview = await f.files.preview({ requestId: 'request_1', candidateId: candidate.candidateId, revision: candidate.revision })
    assert.ok(preview.content.length > 2 * 1024 * 1024)
    assert.ok(preview.files.some(file => file.relativePath.endsWith('data.txt')))
    const pkg = await f.files.packageSelected({ candidateId: candidate.candidateId, snapshotId: preview.snapshotId, operationId: 'operation_1' })
    assert.ok(pkg.bytes > 2 * 1024 * 1024)
    assert.equal(pkg.bytes, preview.estimatedPackageBytes)
  } finally { await f.files.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

test('previews more than ten thousand files without a client count quota', async () => {
  const f = await fixture()
  try {
    const root = await f.files.addProjectRoot(f.project)
    const directory = await addSkill(f.project)
    const resources = join(directory, 'references')
    for (let offset = 0; offset < 10000; offset += 64) {
      await Promise.all(Array.from({ length: Math.min(64, 10000 - offset) }, (_, index) => writeFile(join(resources, `file-${offset + index}.txt`), 'x')))
    }
    const [candidate] = await f.files.scan([root.id])
    assert.ok(candidate)
    const preview = await f.files.preview({ requestId: 'request_1', candidateId: candidate.candidateId, revision: candidate.revision })
    assert.equal(preview.fileCount, 10002)
    assert.equal(preview.files.length, preview.fileCount)
  } finally { await f.files.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

test('streams a package above the former hundred MiB quota', async () => {
  const f = await fixture()
  try {
    const root = await f.files.addProjectRoot(f.project)
    const directory = await addSkill(f.project)
    const resource = await open(join(directory, 'references', 'large.bin'), 'w')
    try { await resource.truncate(100 * 1024 * 1024 + 1) } finally { await resource.close() }
    const [candidate] = await f.files.scan([root.id])
    assert.ok(candidate)
    const preview = await f.files.preview({ requestId: 'request_1', candidateId: candidate.candidateId, revision: candidate.revision })
    assert.ok(preview.estimatedPackageBytes > 100 * 1024 * 1024)
    const pkg = await f.files.packageSelected({ candidateId: candidate.candidateId, snapshotId: preview.snapshotId, operationId: 'operation_1' })
    assert.ok(pkg.bytes > 100 * 1024 * 1024)
    assert.equal(pkg.bytes, preview.estimatedPackageBytes)
    let streamed = 0
    for await (const chunk of pkg.open()) streamed += chunk.byteLength
    assert.equal(streamed, pkg.bytes)
  } finally { await f.files.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

function agentsRoot(files: SkillImportFiles): Promise<{ id: string }> {
  return files.listRoots().then(roots => {
    const root = roots.find(item => item.path.endsWith('/.agents/skills'))
    assert.ok(root)
    return root
  })
}

test('labels OpenCode compatibility roots distinctly and classifies actual user directories', async () => {
  const f = await fixture()
  try {
    const files = new SkillImportFiles({ homeDir: f.home, tempDir: f.temp, platform: 'darwin' })
    const roots = await files.listRoots()
    const openCode = roots.filter(root => root.sources.includes('opencode'))
    assert.equal(openCode.length, 3)
    assert.equal(new Set(openCode.map(root => root.label)).size, 3)
    const shared = roots.find(root => root.sources.includes('agents'))!
    assert.deepEqual(shared.sources, ['agents'])
    const claude = roots.find(root => root.sources.includes('claude-code'))!
    await addSkill(shared.path, 'shared')
    await addSkill(claude.path, 'claude')
    const candidates = await files.scan([shared.id, claude.id])
    assert.deepEqual(candidates.map(candidate => candidate.sources), [['agents'], ['claude-code']])
    await files.dispose()
  } finally {
    await f.files.dispose()
    await rm(f.base, { recursive: true, force: true })
  }
})

test('classifies project skills by their agent directory and keeps generic skills separate', async () => {
  const f = await fixture()
  try {
    const paths = ['.agents/skills', '.claude/skills', '.codex/skills', '.gemini/skills', '.opencode/skills', '.opencode/skill', '.workbuddy/skills', '.codebuddy/skills', '.qoder/skills', '.qwen/skills', '.kimi/skills', 'skills']
    const expected = ['agents', 'claude-code', 'codex', 'gemini-cli', 'opencode', 'opencode', 'workbuddy', 'codebuddy', 'qoder', 'qwen-code', 'kimi-code', 'project']
    for (let i = 0; i < paths.length; i++) await addSkill(join(f.project, paths[i]!), `skill-${i}`)
    const root = await f.files.addProjectRoot(f.project)
    const candidates = await f.files.scan([root.id])
    assert.equal(candidates.length, paths.length)
    for (let i = 0; i < paths.length; i++) {
      const candidate = candidates.find(item => item.locations.some(location => location.relativePath === `${paths[i]}/skill-${i}`))
      assert.ok(candidate)
      assert.deepEqual(candidate.sources, [expected[i]])
    }
    const directRoot = await f.files.addProjectRoot(join(f.project, '.claude', 'skills'))
    assert.deepEqual((await f.files.scan([directRoot.id]))[0]?.sources, ['claude-code'])
  } finally {
    await f.files.dispose()
    await rm(f.base, { recursive: true, force: true })
  }
})

test('discovers domestic agent skills and WorkBuddy plugin skills without scanning unrelated app data', async () => {
  const f = await fixture()
  try {
    const files = new SkillImportFiles({ homeDir: f.home, tempDir: f.temp, platform: 'darwin' })
    const before = await files.listRoots()
    assert.equal(before.some(root => root.sources.includes('workbuddy') || root.sources.includes('doubao-work')), false)
    const paths = [
      ['.workbuddy/skills', 'workbuddy'],
      ['.workbuddy/plugins/cache', 'workbuddy'],
      ['.workbuddy/plugins/marketplaces/workbuddy-builtin/skills', 'workbuddy'],
      ['DoubaoWork/skills', 'doubao-work'],
      ['Library/Application Support/DoubaoWork/Default/.doubaowork/agent_mode/workspace/.skills', 'doubao-work'],
      ['.codebuddy/skills', 'codebuddy'], ['.qoder/skills', 'qoder'], ['.qwen/skills', 'qwen-code'], ['.kimi/skills', 'kimi-code'],
      ['.config/agents/skills', 'agents'],
    ]
    for (const [path] of paths) await addSkill(join(f.home, path!), path === '.workbuddy/plugins/cache' ? 'builtin/docx/1.0.0/skills/report' : 'weekly-report')
    await addSkill(join(f.home, '.workbuddy', 'sessions'), 'not-a-skill-source')
    const home = await realpath(f.home)
    const roots = (await files.listRoots()).filter(root => paths.some(([path]) => root.path === join(home, path!)))
    assert.equal(roots.length, paths.length)
    const candidates = await files.scan(roots.map(root => root.id))
    assert.equal(candidates.length, paths.length)
    for (const [path, source] of paths) {
      const root = roots.find(item => item.path === join(home, path!))!
      const candidate = candidates.find(item => item.locations.some(location => location.rootId === root.id))!
      assert.deepEqual(candidate.sources, [source])
    }
    await files.dispose()
  } finally {
    await f.files.dispose()
    await rm(f.base, { recursive: true, force: true })
  }
})

test('does not authorize a domestic agent skill root redirected outside the home directory', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.home, '.workbuddy'), { recursive: true })
    await addSkill(f.project)
    await symlink(f.project, join(f.home, '.workbuddy', 'skills'))
    assert.equal((await f.files.listRoots()).some(root => root.sources.includes('workbuddy')), false)
  } finally {
    await f.files.dispose()
    await rm(f.base, { recursive: true, force: true })
  }
})

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

test('does not rebind an approved missing root when it becomes a symlink', async () => {
  const f = await fixture()
  try {
    const root = await agentsRoot(f.files)
    await addSkill(f.project, 'outside')
    await mkdir(join(f.home, '.agents'), { recursive: true })
    await symlink(f.project, join(f.home, '.agents', 'skills'), 'dir')
    assert.equal((await f.files.listRoots()).some(item => item.id === root.id), false)
    assert.deepEqual(await f.files.scan([root.id]), [])
    assert.deepEqual(f.files.getScanWarnings(), [{ code: 'ROOT_CHANGED', rootId: root.id }])
  } finally {
    await f.files.dispose()
    await rm(f.base, { recursive: true, force: true })
  }
})

test('allows an approved missing root to be created as an ordinary directory', async () => {
  const f = await fixture()
  try {
    const root = await agentsRoot(f.files)
    await addSkill(join(f.home, '.agents', 'skills'))
    assert.equal((await f.files.scan([root.id])).length, 1)
    assert.deepEqual(f.files.getScanWarnings(), [])
  } finally {
    await f.files.dispose()
    await rm(f.base, { recursive: true, force: true })
  }
})

test('skips never-created default roots but warns when an existing root disappears', async () => {
  const f = await fixture()
  try {
    const root = await agentsRoot(f.files)
    assert.deepEqual(await f.files.scan([root.id]), [])
    assert.deepEqual(f.files.getScanWarnings(), [])
    const skills = join(f.home, '.agents', 'skills')
    await addSkill(skills)
    await f.files.listRoots()
    await rename(skills, join(f.home, '.agents', 'original-skills'))
    await f.files.listRoots()
    assert.deepEqual(await f.files.scan([root.id]), [])
    assert.deepEqual(f.files.getScanWarnings(), [{ code: 'ROOT_UNAVAILABLE', rootId: root.id }])
  } finally {
    await f.files.dispose()
    await rm(f.base, { recursive: true, force: true })
  }
})

test('does not rebind an authorized project root when replaced by a symlink', async () => {
  const f = await fixture()
  try {
    const root = await f.files.addProjectRoot(f.project)
    const outside = join(f.base, 'outside-project')
    await addSkill(outside)
    await rename(f.project, join(f.base, 'original-project'))
    await symlink(outside, f.project, 'dir')
    await f.files.listRoots()
    assert.deepEqual(await f.files.scan([root.id]), [])
    assert.deepEqual(f.files.getScanWarnings(), [{ code: 'ROOT_CHANGED', rootId: root.id }])
  } finally {
    await f.files.dispose()
    await rm(f.base, { recursive: true, force: true })
  }
})

test('rejects an existing authorized root replaced by a symlink before scan', async () => {
  const f = await fixture()
  try {
    const skills = join(f.home, '.agents', 'skills')
    await addSkill(skills)
    const root = await agentsRoot(f.files)
    await addSkill(f.project, 'outside')
    await rename(skills, join(f.home, '.agents', 'original-skills'))
    await symlink(f.project, skills, 'dir')
    await f.files.listRoots()
    assert.deepEqual(await f.files.scan([root.id]), [])
    assert.deepEqual(f.files.getScanWarnings(), [{ code: 'ROOT_CHANGED', rootId: root.id }])
  } finally {
    await f.files.dispose()
    await rm(f.base, { recursive: true, force: true })
  }
})

test('rejects preview and packaging after an authorized root is replaced by a symlink', async () => {
  const f = await fixture()
  try {
    const skills = join(f.home, '.agents', 'skills')
    await addSkill(skills)
    const root = await agentsRoot(f.files)
    const [candidate] = await f.files.scan([root.id])
    assert.ok(candidate)
    const preview = await f.files.preview({ requestId: 'req-root-replaced', candidateId: candidate.candidateId, revision: 1 })
    await addSkill(f.project)
    await rename(skills, join(f.home, '.agents', 'original-skills'))
    await symlink(f.project, skills, 'dir')
    await assert.rejects(f.files.preview({ requestId: 'req-root-replaced-again', candidateId: candidate.candidateId, revision: 1 }), /PATH_OUTSIDE_ROOT/)
    await assert.rejects(f.files.packageSelected({ candidateId: candidate.candidateId, snapshotId: preview.snapshotId, operationId: 'op-root-replaced' }), /PATH_OUTSIDE_ROOT/)
    assert.deepEqual(await readdir(f.temp).catch(() => []), [])
  } finally {
    await f.files.dispose()
    await rm(f.base, { recursive: true, force: true })
  }
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
  // Cancellation can reject while the test is still polling for the archive.
  void packaging.catch(() => undefined)
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

test('cancellation after source handle validation rejects safely and removes the active archive', async t => {
  const f = await fixture()
  const skill = await addSkill(join(f.home, '.agents', 'skills'))
  const root = await agentsRoot(f.files)
  const [candidate] = await f.files.scan([root.id])
  assert.ok(candidate)
  const preview = await f.files.preview({ requestId: 'req-cancel-validated', candidateId: candidate.candidateId, revision: 1 })
  const controller = new AbortController()
  const reason = new Error('IMPORT_CANCELLED')
  const handle = await open(join(skill, 'SKILL.md'), 'r')
  const prototype = Object.getPrototypeOf(handle) as FileHandle
  const originalStat = prototype.stat
  await handle.close()
  let cancelledDuringValidation = false
  let cancelledHandle: FileHandle | undefined
  const mocked = t.mock.method(prototype, 'stat', async function (this: FileHandle, ...args: Parameters<FileHandle['stat']>) {
    const info = await Reflect.apply(originalStat, this, args)
    if (!controller.signal.aborted && (await readdir(f.temp).catch(() => [])).some(name => name.endsWith('.zip'))) {
      cancelledDuringValidation = true
      cancelledHandle = this
      controller.abort(reason)
    }
    return info
  })
  try {
    await assert.rejects(f.files.packageSelected({ candidateId: candidate.candidateId, snapshotId: preview.snapshotId, operationId: 'op-cancel-validated' }, controller.signal), error => error === reason || error instanceof Error && error.name === 'AbortError' && error.cause === reason)
    assert.equal(cancelledDuringValidation, true)
    assert.equal(cancelledHandle?.fd, -1, 'the source handle must close before cancellation settles')
    assert.deepEqual((await readdir(f.temp)).filter(name => name.endsWith('.zip')), [])
  } finally {
    mocked.mock.restore()
    await f.files.dispose()
    await rm(f.base, { recursive: true, force: true })
  }
})
