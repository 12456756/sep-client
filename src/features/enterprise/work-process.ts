import type { WorkActivity, WorkStatus } from './types'

const TOOL_LABELS: Readonly<Record<string, string>> = {
  ls: '查看目录', find: '查找文件', grep: '搜索文件内容', read: '读取文件',
  bash: '执行命令', write: '写入文件', edit: '编辑文件',
}
const BROWSER_LABELS: Readonly<Record<string, string>> = {
  browser_navigate: '打开网页', browser_navigate_back: '返回上一页',
  browser_snapshot: '读取网页内容', browser_click: '点击网页元素',
  browser_type: '输入网页内容', browser_fill_form: '填写网页表单',
  browser_select_option: '选择网页选项', browser_press_key: '执行网页按键操作',
  browser_tabs: '管理浏览器标签页', browser_wait_for: '等待网页响应',
  browser_handle_dialog: '处理网页对话框', browser_close: '关闭浏览器',
  browser_take_screenshot: '截取网页画面', browser_evaluate: '执行网页操作',
}

/** 只改变用户界面的文案，不改写事件、后台日志或其他模块的活动投影。 */
export function processActivityLabel(activity: WorkActivity): string {
  const name = activity.toolName
  if (name) {
    if (TOOL_LABELS[name]) return TOOL_LABELS[name]
    if (name.startsWith('mcp__playwright__')) {
      return BROWSER_LABELS[name.slice('mcp__playwright__'.length)] ?? '操作浏览器'
    }
    return name.startsWith('mcp__') ? '执行扩展操作' : '执行工具操作'
  }
  if (activity.text.startsWith('运行遇到问题：')) return '本轮处理遇到问题'
  return activity.text.replace(/^(?:开始执行|已完成)：/, '')
}

export function currentWorkOperation(status: WorkStatus, activities: readonly WorkActivity[]): string {
  if (status === 'completed') return '本轮工作已完成'
  if (status === 'paused') return '工作已终止'
  if (status === 'failed') return '工作已中断'
  const waiting = activities.filter(activity => activity.state === 'waiting-user').at(-1)
  if (waiting) return `等待你的确认：${processActivityLabel(waiting)}`
  if (status === 'waiting-user') return '等待你的确认'
  const running = activities.filter(activity => activity.state === 'running').at(-1)
  if (running) {
    const label = processActivityLabel(running)
    return label.startsWith('正在') ? label : `正在${label}`
  }
  return status === 'arranging' ? '正在准备工作' : '正在处理，请稍候'
}
