export type SettingsPageId = 'general' | 'account' | 'voice'
export type SettingsSectionId = 'models' | 'workspace' | 'profile' | 'enterprise' | 'speech'

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
    { id: 'models', title: '模型', keywords: '默认模型 系统默认 AI model' },
    { id: 'workspace', title: '文件与目录', keywords: '默认工作目录 文件夹 存储位置 workspace' },
  ] },
  { id: 'account', title: '账号', group: '个人', sections: [
    { id: 'profile', title: '个人资料', keywords: '头像 姓名 邮箱 我的账号 刷新资料 profile' },
    { id: 'enterprise', title: '企业资料', keywords: '企业 名称 标志 Logo', managerOnly: true },
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
