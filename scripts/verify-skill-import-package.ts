import * as assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'
import { SkillImportFiles } from '../electron/data/skill-import-files'

// Use the adjacent backend's actual package parser with isolated storage, without starting its server.
const backend = resolve(process.argv[2] ?? '../SEP/backend')
const nativeRequire = createRequire(join(backend, 'package.json'))
const modules = new Map<string, Record<string, unknown>>()
function loadSource(path: string): Record<string, unknown> {
  if (modules.has(path)) return modules.get(path)!
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
    fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true, esModuleInterop: true },
  }).outputText
  const module = { exports: {} as Record<string, unknown> }
  modules.set(path, module.exports)
  const requireSource = (name: string): unknown => {
    if (name === 'shared') return loadSource(join(backend, 'src/shared/client-skill-artifact.dto.ts'))
    if (name.startsWith('.')) return loadSource(resolve(dirname(path), name + '.ts'))
    return nativeRequire(name)
  }
  compileFunction(compiled, ['require', 'exports', 'module', '__filename', '__dirname'], { filename: path })(requireSource, module.exports, module, path, dirname(path))
  return module.exports
}

interface PackageParser {
  store(file: { buffer: Buffer; originalname: string }): Promise<{ sha256: string; fileCount: number; content: string; suggested: { name: string | null } }>
}
const scratch = await mkdtemp(join(tmpdir(), 'sep-import-roundtrip-'))
const files = new SkillImportFiles({ homeDir: join(scratch, 'home'), tempDir: join(scratch, 'zip') })
try {
  const project = join(scratch, 'project')
  const skill = join(project, '中文技能')
  await mkdir(join(skill, 'references'), { recursive: true })
  await mkdir(join(skill, 'assets/空目录'), { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), '---\nname: 中文助手\ndescription: |\n  汇总资料\n  生成报告\n---\n# 步骤\n阅读 references/样例.md，整理中文报告。\n')
  await writeFile(join(skill, 'references/样例.md'), '真实 UTF-8 资源。\n')
  const root = await files.addProjectRoot(project)
  const [candidate] = await files.scan([root.id])
  assert.ok(candidate)
  const preview = await files.preview({ requestId: 'roundtrip', candidateId: candidate.candidateId, revision: candidate.revision })
  const archive = await files.packageSelected({ candidateId: candidate.candidateId, snapshotId: preview.snapshotId, operationId: 'roundtrip' })
  const chunks: Uint8Array[] = []
  for await (const chunk of archive.open()) chunks.push(chunk)
  const buffer = Buffer.concat(chunks)
  const Zip = nativeRequire('adm-zip') as new (buffer: Buffer) => { getEntries(): Array<{ entryName: string; isDirectory: boolean }> }
  assert.ok(new Zip(buffer).getEntries().some(entry => entry.entryName === 'assets/空目录/' && entry.isDirectory))
  const Parser = loadSource(join(backend, 'src/modules/skill-package/skill-package.service.ts')).SkillPackageService as new (config: { get(name: string): string | undefined }) => PackageParser
  const parser = new Parser({ get: name => name === 'SKILL_PACKAGE_DIR' ? join(scratch, 'backend-packages') : undefined })
  const result = await parser.store({ buffer, originalname: archive.filename })
  assert.equal(result.sha256, archive.sha256)
  assert.equal(result.fileCount, 2)
  assert.equal(result.suggested.name, '中文助手')
  assert.match(result.content, /阅读 references\/样例.md/)
  const output = resolve('output/playwright/skill-import')
  await mkdir(output, { recursive: true })
  const evidence = { passed: true, backend, bytes: archive.bytes, sha256: result.sha256, fileCount: result.fileCount,
    checks: ['actual-SEP-SkillPackageService.store', 'Chinese-UTF8-entry-and-resource', 'multiline-YAML', 'ZIP-CRC-and-hash', 'empty-directories'] }
  await writeFile(join(output, 'package-roundtrip.json'), JSON.stringify(evidence, null, 2) + '\n')
  process.stdout.write(JSON.stringify(evidence) + '\n')
} finally {
  await files.dispose()
  await rm(scratch, { recursive: true, force: true })
}
