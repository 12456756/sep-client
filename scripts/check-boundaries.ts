/**
 * scripts/check-boundaries.ts — 分层边界与编码回归检查
 *
 * 规则分两档：
 *   enforced  现在就必须通过，违反即 exit 1
 *   pending   目标结构尚未落成（见 docs/architecture/后端结构重构实施方案.md 第 3 章），
 *             先报数不拦截；对应阶段完成后把 status 改成 enforced
 *
 * 用法：npm run check:boundaries
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

type RuleStatus = 'enforced' | 'pending'

interface Violation {
  file: string
  line: number
  detail: string
}

interface SourceFile {
  /** 仓库相对路径，正斜杠。 */
  path: string
  text: string
  lines: string[]
  invalidUtf8: boolean
  hasBom: boolean
}

interface Rule {
  id: string
  status: RuleStatus
  description: string
  /** pending 规则说明它在哪个阶段转为 enforced。 */
  enforcedAt?: string
  check(files: SourceFile[]): Violation[]
}

const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'json', 'md', 'html', 'css', 'sh', 'yml', 'yaml', 'txt', 'editorconfig',
])

function isTextFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return base === '.editorconfig'
  return TEXT_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())
}

function loadSourceFiles(): SourceFile[] {
  const listed = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  const strict = new TextDecoder('utf-8', { fatal: true })
  const files: SourceFile[] = []
  for (const path of listed.split('\0')) {
    if (!path || !isTextFile(path)) continue
    let bytes: Buffer
    try {
      bytes = readFileSync(path)
    } catch {
      continue // 已删除但仍在索引里的条目
    }
    let text = ''
    let invalidUtf8 = false
    try {
      text = strict.decode(bytes)
    } catch {
      invalidUtf8 = true
      text = bytes.toString('utf8')
    }
    files.push({
      path,
      text,
      lines: text.split('\n'),
      invalidUtf8,
      hasBom: bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    })
  }
  return files
}

/**
 * 反向表：Unicode 字符 -> 它在 GBK/cp936 里的字节。用运行时解码 GBK 全部双字节
 * 组合再取反得到，不引第三方依赖。U+20AC 固定映射到单字节 0x80——2026-09-01 那次
 * 事故的编辑器用的是 cp936，`─`(E2 94 80) 正是被读成 `鈹€` 的。 mojibake-sample
 */
let gbkBytesByChar: Map<string, number[]> | null = null

function gbkTable(): Map<string, number[]> {
  if (gbkBytesByChar) return gbkBytesByChar
  const decoder = new TextDecoder('gbk')
  const table = new Map<string, number[]>()
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      const decoded = decoder.decode(new Uint8Array([lead, trail]))
      if (decoded.length !== 1 || decoded === '�') continue
      if (!table.has(decoded)) table.set(decoded, [lead, trail])
    }
  }
  table.set('€', [0x80])
  gbkBytesByChar = table
  return table
}

const PLAUSIBLE_RANGES: readonly [number, number][] = [
  [0x00a7, 0x00a7], // §
  [0x2000, 0x27bf], // 通用标点、箭头、符号
  [0x2500, 0x257f], // 制表符
  [0x3000, 0x303f], // 中日韩标点
  [0x4e00, 0x9fff], // 中日韩统一表意
  [0xff00, 0xffef], // 全角
]

function isCjk(code: number): boolean {
  return code >= 0x4e00 && code <= 0x9fff
}

function looksLikeSource(text: string): boolean {
  let anchored = false
  for (const char of text) {
    const code = char.codePointAt(0) as number
    if (code < 0x80) continue
    if (!PLAUSIBLE_RANGES.some(([low, high]) => code >= low && code <= high)) return false
    if (isCjk(code) || (code >= 0x2500 && code <= 0x257f)) anchored = true
  }
  return anchored
}

/** 把一段非 ASCII 文本按 GBK 编回字节，再当 UTF-8 读；成功即说明它是乱码。 */
function reverseGbkMisread(run: string): string | null {
  const table = gbkTable()
  const bytes: number[] = []
  for (const char of run) {
    const mapped = table.get(char)
    if (!mapped) return null
    bytes.push(...mapped)
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes))
    return looksLikeSource(decoded) ? decoded : null
  } catch {
    return null
  }
}

const NON_ASCII_RUN = /[^\p{ASCII}]+/gu

function hasPrivateUseArea(run: string): boolean {
  for (const char of run) {
    const code = char.codePointAt(0) as number
    if (code >= 0xe000 && code <= 0xf8ff) return true
  }
  return false
}

function hasKatakana(run: string): boolean {
  for (const char of run) {
    const code = char.codePointAt(0) as number
    if (code >= 0x30a0 && code <= 0x30ff) return true
  }
  return false
}

const encodingRules: Rule[] = [
  {
    id: 'encoding:utf8',
    status: 'enforced',
    description: '全部文本文件必须是无 BOM 的合法 UTF-8',
    check: files => files.flatMap(file => {
      const problems: Violation[] = []
      if (file.invalidUtf8) problems.push({ file: file.path, line: 1, detail: '不是合法 UTF-8' })
      if (file.hasBom) problems.push({ file: file.path, line: 1, detail: '带 UTF-8 BOM' })
      return problems
    }),
  },
]

/**
 * 允许一行携带乱码样例的豁免标记。方案第 4.4 节与本文件自身都必须原样引用坏字符，
 * 否则说不清事故长什么样；豁免必须显式写在同一行，便于审。
 */
const MOJIBAKE_SAMPLE_MARKER = 'mojibake-sample'

encodingRules.push({
  id: 'encoding:mojibake',
  status: 'enforced',
  description: '不允许 GBK 误读留下的乱码（GBK 往返 / 私用区 / 片假名）',
  check: files => {
    const problems: Violation[] = []
    for (const file of files) {
      if (file.invalidUtf8) continue
      file.lines.forEach((line, index) => {
        if (line.includes(MOJIBAKE_SAMPLE_MARKER)) return
        for (const match of line.matchAll(NON_ASCII_RUN)) {
          const run = match[0]
          const reversed = reverseGbkMisread(run)
          if (reversed) {
            problems.push({
              file: file.path,
              line: index + 1,
              detail: `${JSON.stringify(run)} 疑为 ${JSON.stringify(reversed)} 被按 GBK 读入后存回`,
            })
          } else if (hasPrivateUseArea(run)) {
            problems.push({ file: file.path, line: index + 1, detail: `${JSON.stringify(run)} 含私用区字符` })
          } else if (hasKatakana(run)) {
            problems.push({ file: file.path, line: index + 1, detail: `${JSON.stringify(run)} 含片假名（本仓库无日文文案）` })
          }
        }
      })
    }
    return problems
  },
})

/** 只扫后端源码，跳过测试与本脚本自身。 */
function backendSources(files: SourceFile[], prefix: string): SourceFile[] {
  return files.filter(file =>
    file.path.startsWith(prefix) &&
    (file.path.endsWith('.ts') || file.path.endsWith('.tsx')) &&
    !file.path.endsWith('.test.ts'))
}

function matchLines(file: SourceFile, pattern: RegExp, detail: (line: string) => string): Violation[] {
  return file.lines.flatMap((line, index) =>
    pattern.test(line) ? [{ file: file.path, line: index + 1, detail: detail(line.trim()) }] : [])
}

/**
 * 整行都是注释。用于那些"匹配的是标识符或字符串字面量"的规则——文档里提到
 * `task:create` 这样的通道名是必要的说明，不是违规；不排除的话规则会逼人删注释。
 * 行尾注释不算：那一行上还有真代码。
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

function matchCodeLines(file: SourceFile, pattern: RegExp, detail: (line: string) => string): Violation[] {
  return file.lines.flatMap((line, index) =>
    !isCommentLine(line) && pattern.test(line)
      ? [{ file: file.path, line: index + 1, detail: detail(line.trim()) }]
      : [])
}

/**
 * main -> renderer 推送的唯一出口。方案 3.3 节 B1 的可执行形态：`TaskManager` 原来
 * 自己持有 BrowserWindow 直接 send，Phase 4 换成注入的 `runtime/task-notifier.ts` 接口。
 */
const RENDERER_PUSH_EXIT = 'electron/bootstrap/renderer-bridge.ts'

const layerRules: Rule[] = [
  {
    id: 'B1a:renderer-push-single-exit',
    status: 'enforced',
    description: `webContents.send 只允许出现在 ${RENDERER_PUSH_EXIT}`,
    check: files => backendSources(files, 'electron/')
      .filter(file => file.path !== RENDERER_PUSH_EXIT)
      .flatMap(file => matchLines(
        file,
        /webContents\.send\s*\(/,
        line => `绕过唯一推送出口：${line.slice(0, 80)}`,
      )),
  },
  {
    id: 'B1b:ipc-registration-in-controller',
    status: 'pending',
    enforcedAt: 'Phase 6（控制层表驱动）',
    description: 'ipcMain 与通道字面量只允许出现在 electron/controller/',
    check: files => backendSources(files, 'electron/')
      .filter(file => !file.path.startsWith('electron/controller/'))
      .flatMap(file => matchCodeLines(
        file,
        /\bipcMain\b|(['"`])(?:auth|task|conversation|workflow|pi|util):[a-z-]+\1/,
        line => `控制层之外出现 IPC 细节：${line.slice(0, 80)}`,
      )),
  },
  {
    id: 'B2:service-purity',
    status: 'enforced',
    description: 'electron/service/ 不得直接依赖 pi/ 或 @earendil-works/*',
    check: files => backendSources(files, 'electron/service/').flatMap(file => matchLines(
      file,
      /from\s+['"](?:\.\.?\/)*pi\/|from\s+['"]@earendil-works\//,
      line => `服务层直连 SDK：${line.slice(0, 80)}`,
    )),
  },
  {
    id: 'B3:data-purity',
    status: 'pending',
    enforcedAt: 'Phase 7（数据层归一）',
    description: 'electron/data/ 不得依赖 service/ 或 runtime/',
    check: files => backendSources(files, 'electron/data/').flatMap(file => matchLines(
      file,
      /from\s+['"](?:\.\.?\/)*(?:service|runtime)\//,
      line => `数据层向上依赖：${line.slice(0, 80)}`,
    )),
  },
  {
    id: 'B4:common-leaf',
    status: 'enforced',
    description: 'electron/common/ 是叶子，不得依赖其他后端分层',
    check: files => backendSources(files, 'electron/common/').flatMap(file => matchLines(
      file,
      /from\s+['"](?:\.\.?\/)*(?:bootstrap|controller|service|data|domain|runtime|pi|tasks|auth)\//,
      line => `common 依赖了上层：${line.slice(0, 80)}`,
    )),
  },
]

/**
 * 唯一允许构造错误信封的目录。方案第 4.2 节：「router.ts 的 catch 调它，业务代码里
 * 不再出现任何手写的 `{ success: false, error: {...} }`」。
 *
 * C11 就是这条没被机器盯住的后果：Phase 2 漏掉 auth:get-instances 与
 * util:select-directory 共 5 处，于是 AuthApiError 的英文 message 被直送 IPC
 * （App.tsx 原样显示），而且三条分支都不记日志。
 */
const ENVELOPE_FACTORY_DIR = 'electron/errors/'

const errorRules: Rule[] = [
  {
    id: 'errors:no-handwritten-envelope',
    status: 'enforced',
    description: `错误信封只能由 ${ENVELOPE_FACTORY_DIR} 构造，业务代码走 failure() / reportFailure()`,
    check: files => backendSources(files, 'electron/')
      .filter(file => !file.path.startsWith(ENVELOPE_FACTORY_DIR))
      .flatMap(file => matchLines(
        file,
        /\berror:\s*\{/,
        line => `手写错误信封：${line.slice(0, 80)}`,
      )),
  },
]

/** logger 自身与 undici 兼容层在 logger 可用之前运行，允许裸 console。 */
const CONSOLE_ALLOWLIST = new Set([
  'electron/common/logger.ts',
  'electron/common/undici-polyfill.ts',
  'scripts/check-boundaries.ts',
])

const loggingRules: Rule[] = [
  {
    id: 'log:no-bare-console',
    status: 'enforced',
    description: '后端禁止裸 console.*，统一走 common/logger.ts',
    check: files => backendSources(files, 'electron/')
      .filter(file => !CONSOLE_ALLOWLIST.has(file.path))
      .flatMap(file => matchLines(
        file,
        /\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(/,
        line => `裸 console：${line.slice(0, 80)}`,
      )),
  },
]

/**
 * Phase 0 发现 `tasks/domain/workflow-graph.test.ts` 与 `workflow-executor.test.ts`
 * 从未被运行过——它们不在 package.json 的显式文件列表里。这条规则确保不再复发：
 * 每个 electron/ 下的测试文件都必须被 `test:tasks` 的某个 glob 命中。
 */
function testGlobsFromPackageJson(): string[] {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>
  }
  const script = packageJson.scripts?.['test:tasks'] ?? ''
  return script.split(/\s+/).filter(token => token.endsWith('.test.ts'))
}

function globMatches(glob: string, path: string): boolean {
  const pattern = glob
    .split('/')
    .map(segment => segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('/')
  return new RegExp(`^${pattern}$`).test(path)
}

const testRules: Rule[] = [
  {
    id: 'test:every-suite-registered',
    status: 'enforced',
    description: 'electron/ 下每个 *.test.ts 都必须被 npm run test:tasks 覆盖',
    check: files => {
      const globs = testGlobsFromPackageJson()
      if (globs.length === 0) {
        return [{ file: 'package.json', line: 1, detail: 'test:tasks 里找不到任何 *.test.ts 目标' }]
      }
      return files
        .filter(file => file.path.startsWith('electron/') && file.path.endsWith('.test.ts'))
        .filter(file => !globs.some(glob => globMatches(glob, file.path)))
        .map(file => ({ file: file.path, line: 1, detail: 'test:tasks 不会运行这个测试文件' }))
    },
  },
]

const rules: Rule[] = [...encodingRules, ...layerRules, ...errorRules, ...loggingRules, ...testRules]

function main(): void {
  const files = loadSourceFiles()
  let failed = false
  console.log(`check-boundaries: 扫描 ${files.length} 个文本文件\n`)

  for (const rule of rules) {
    const violations = rule.check(files)
    const badge = rule.status === 'enforced' ? 'enforced' : `pending -> ${rule.enforcedAt ?? '未定'}`
    if (violations.length === 0) {
      console.log(`  ok       ${rule.id}  [${badge}]`)
      continue
    }
    if (rule.status === 'enforced') failed = true
    console.log(`  ${rule.status === 'enforced' ? 'FAIL    ' : 'todo    '} ${rule.id}  [${badge}]  ${violations.length} 处`)
    console.log(`           ${rule.description}`)
    for (const violation of violations.slice(0, 20)) {
      console.log(`           ${violation.file}:${violation.line}  ${violation.detail}`)
    }
    if (violations.length > 20) console.log(`           …… 另有 ${violations.length - 20} 处`)
  }

  console.log(failed ? '\ncheck-boundaries: 有 enforced 规则未通过' : '\ncheck-boundaries: 全部 enforced 规则通过')
  process.exitCode = failed ? 1 : 0
}

main()
