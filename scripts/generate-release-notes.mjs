import { mkdir, readFile, writeFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const channel = process.env.SEP_RELEASE_CHANNEL || process.argv[2] || 'beta'
const environment = process.env.SEP_RELEASE_ENVIRONMENT || (channel === 'stable' ? 'production' : 'integration')
const buildTime = new Date().toISOString()
const notes = `# SEP Client ${pkg.version} (${channel})\n\n- 环境：${environment}\n- 构建时间：${buildTime}\n- 发行目标：macOS Intel（x64）DMG、macOS Apple Silicon（arm64）DMG、Windows x64 NSIS 安装包。\n- 本机联调产物未包含代码签名、公证和 OSS 自动上传。\n- Linux 和 macOS ZIP 不属于本版本发行目标。\n`
await mkdir('dist', { recursive: true })
await writeFile(`dist/RELEASE-NOTES-${channel}.md`, notes)
console.log(`release notes: dist/RELEASE-NOTES-${channel}.md`)
