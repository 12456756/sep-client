import { mkdir, readFile, writeFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const channel = process.env.SEP_RELEASE_CHANNEL || process.argv[2] || 'beta'
const environment = process.env.SEP_RELEASE_ENVIRONMENT || (channel === 'stable' ? 'production' : 'integration')
const buildTime = new Date().toISOString()
const notes = `# SEP Client ${pkg.version} (${channel})\n\n- 环境：${environment}\n- 构建时间：${buildTime}\n- 按构建主机生成对应平台产物：macOS DMG/ZIP、Windows x64 NSIS 或 Linux AppImage。\n- 本机联调产物未包含代码签名、公证和 OSS 自动上传。\n`
await mkdir('dist', { recursive: true })
await writeFile(`dist/RELEASE-NOTES-${channel}.md`, notes)
console.log(`release notes: dist/RELEASE-NOTES-${channel}.md`)
