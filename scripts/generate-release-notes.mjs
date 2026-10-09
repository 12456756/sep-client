import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const channel = process.env.SEP_RELEASE_CHANNEL || process.argv[2] || 'beta'
if (!['beta', 'stable'].includes(channel)) throw new Error('channel must be beta or stable')
const directory = process.argv[3] || 'dist'
const environment = process.env.SEP_RELEASE_ENVIRONMENT || (channel === 'stable' ? 'production' : 'integration')
const buildTime = new Date().toISOString()
const notes = `# SEP Client ${pkg.version} (${channel})\n\n- 环境：${environment}\n- 构建时间：${buildTime}\n- 按构建主机生成对应平台产物：macOS DMG/ZIP、Windows x64 NSIS 或 Linux AppImage。\n- 本机联调产物未包含代码签名、公证和 OSS 自动上传。\n`
await mkdir(directory, { recursive: true })
await writeFile(join(directory, `RELEASE-NOTES-${channel}.md`), notes)
console.log(`release notes: ${join(directory, `RELEASE-NOTES-${channel}.md`)}`)
