export type SettingsPageId = 'general' | 'account' | 'voice' | 'multimedia'
export type SettingsSectionId = 'permissions' | 'models' | 'workspace' | 'window' | 'profile' | 'enterprise' | 'speech' | 'multimedia'

interface SettingsSection {
  id: SettingsSectionId
  title: string
  keywords: string
  managerOnly?: boolean
}

export interface SettingsPage {
  id: SettingsPageId
  title: string
  group: string
  sections: readonly SettingsSection[]
}

// Navigation and global search share the same catalog as categories grow.
const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: 'general', title: '常规', group: '个人', sections: [
    { id: 'permissions', title: '权限', keywords: '新会话默认权限 仅可查看 工作区内修改 完全访问 本机文件' },
    { id: 'window', title: '关闭窗口', keywords: '关闭按钮 每次询问 最小化 直接退出 不再提示' },
    { id: 'models', title: '模型', keywords: '默认模型 系统默认 AI model' },
    { id: 'workspace', title: '文件与目录', keywords: '默认工作目录 自动保存生成的文件 生成文件默认目录 保存位置 文件夹 存储位置 音视频临时文件位置 缓存 workspace' },
  ] },
  { id: 'account', title: '账号', group: '个人', sections: [
    { id: 'profile', title: '个人资料', keywords: '头像 姓名 邮箱 我的账号 刷新资料 profile' },
    { id: 'enterprise', title: '企业资料', keywords: '企业 名称 标志 Logo', managerOnly: true },
  ] },
  { id: 'multimedia', title: '多媒体', group: '个人', sections: [
    { id: 'multimedia', title: '图片与视频', keywords: '员工 模型 参数 允许值 建议值 默认值 范围 参考图 分辨率 尺寸 质量 时长 格式 multimedia image video' },
  ] },
  { id: 'voice', title: '语音', group: '个人', sections: [
    { id: 'speech', title: '语音输入', keywords: '允许语音输入 麦克风 权限 系统 设置 microphone' },
  ] },
]

export function getSettingsPages(canManage: boolean, speechSupported: boolean, query = ''): SettingsPage[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return SETTINGS_PAGES.filter(page => page.id !== 'voice' || speechSupported).map(page => ({
    ...page,
    sections: page.sections.filter(section => {
      if (section.managerOnly && !canManage) return false
      const text = `${page.title} ${section.title} ${section.keywords}`.toLocaleLowerCase()
      return terms.every(term => text.includes(term))
    }),
  })).filter(page => page.sections.length > 0)
}
