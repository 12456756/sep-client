const NATIVE_ROLE = 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'
const NATIVE_END = 'Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)'
const FIXED_TRANSLATIONS = new Map<string, string>([
  [NATIVE_ROLE, '你运行在 Pi 中。你通过读取文件、执行命令、编辑代码和创建新文件来帮助用户。'],
  ['Available tools:', '可用工具：'],
  ['In addition to the tools above, you may have access to other custom tools depending on the project.', '除上述工具外，你可能还可以使用项目提供的其他自定义工具。'],
  ['Guidelines:', '指南：'],
  ['- Use bash for file operations like ls, rg, find', '- 使用 bash 进行 ls、rg、find 等文件操作。'],
  ['- Be concise in your responses', '- 回复简洁。'],
  ['- Show file paths clearly when working with files', '- 操作文件时清楚展示文件路径。'],
  ['Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):', 'Pi 文档（仅在用户询问 Pi 本身、SDK、扩展、主题、技能或 TUI 时阅读）：'],
  ['- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory', '阅读 Pi 文档或示例时，应在上述附加文档目录中解析 docs/...，在示例目录中解析 examples/...，不要相对于当前工作目录解析。'],
  ['- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)', `询问以下主题时，阅读对应文档：
- 扩展：docs/extensions.md、examples/extensions/
- 主题：docs/themes.md
- 技能：docs/skills.md
- 提示词模板：docs/prompt-templates.md
- TUI 组件：docs/tui.md
- 快捷键：docs/keybindings.md
- SDK 集成：docs/sdk.md
- 自定义 Provider：docs/custom-provider.md
- 添加模型：docs/models.md
- Pi 包：docs/packages.md
- 环境变量：docs/environment-variables.md`],
  ['- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing', '处理 Pi 相关问题时，阅读完整的相关 Markdown 文档和示例，并遵循其中的交叉引用。'],
  [`- ${NATIVE_END}`, '始终完整阅读 Pi 的相关 Markdown 文档，并遵循关联文档链接（例如 TUI API 细节见 tui.md）。'],
])

/** Translate only the SDK-owned header; project instructions and skill bodies stay opaque. */
export function translatePiNativeSystemPrompt(prompt: string): string {
  if (!prompt.startsWith(NATIVE_ROLE)) return prompt
  const end = prompt.indexOf(NATIVE_END)
  const boundary = end < 0 ? prompt.indexOf('\n\n<project_context>') : end + NATIVE_END.length
  const header = boundary < 0 ? prompt : prompt.slice(0, boundary)
  const tail = boundary < 0 ? '' : prompt.slice(boundary)
  const translated = header.split('\n').map(line => {
    const fixed = FIXED_TRANSLATIONS.get(line)
    if (fixed !== undefined) return fixed
    if (line.startsWith('- Main documentation: ')) return line.replace('- Main documentation: ', '- 主要文档：')
    if (line.startsWith('- Additional docs: ')) return line.replace('- Additional docs: ', '- 附加文档：')
    if (line.startsWith('- Examples: ')) return line.replace('- Examples: ', '- 示例：').replace(/ \(extensions, custom tools, SDK\)$/, '（扩展、自定义工具、SDK）')
    return line
  }).join('\n').replace('可用工具：\n(none)', '可用工具：\n无')
  return (translated + tail).replace(/(^|\n)Current working directory: ([^\r\n]*)$/, '$1当前工作目录：$2')
}
