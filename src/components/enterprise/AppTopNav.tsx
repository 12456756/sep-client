/**
 * 顶部水平导航栏 - Phase 1 新增组件
 *
 * 取代原来的左侧 AppSideNav，采用现代桌面应用的顶部导航模式。
 * 56px 高，包含：Logo + 企业名 → 5个导航项 → 搜索/通知/头像。
 *
 * 设计规范：
 * - 导航项高度 56px，padding 0 20px
 * - 活跃项：terracotta 颜色 + 底部 2px 边框
 * - 悬停：淡 terracotta 背景 rgba(196, 97, 47, 0.08)
 */

import { Bell, ClipboardList, GraduationCap, LayoutGrid, ListTodo, Search, Users } from 'lucide-react';
import type { AppRoute, AppRouteName } from '../../features/enterprise/types';

interface Props {
  enterpriseName: string;
  enterpriseMark: string;
  current: AppRouteName;
  needsMeCount: number;
  userName: string;
  onNavigate: (route: AppRoute) => void;
  onLogout: () => void;
}

const NAV_ITEMS: { name: AppRouteName; label: string; icon: typeof Users; route: AppRoute }[] = [
  { name: 'home', label: '首页', icon: LayoutGrid, route: { name: 'home' } },
  { name: 'employees', label: '硅基员工', icon: Users, route: { name: 'employees' } },
  { name: 'arrange', label: '安排工作', icon: ListTodo, route: { name: 'arrange' } },
  { name: 'records', label: '工作记录', icon: ClipboardList, route: { name: 'records' } },
  { name: 'skills', label: '技能库', icon: GraduationCap, route: { name: 'skills' } },
];

/** 详情页算在它的列表页下面：员工详情亮「硅基员工」，工作详情亮「工作记录」。 */
function isActive(item: AppRouteName, current: AppRouteName): boolean {
  if (item === current) return true;
  if (item === 'employees') return current === 'employee' || current === 'organization';
  if (item === 'records') return current === 'work';
  return false;
}

export function AppTopNav({
  enterpriseName,
  enterpriseMark,
  current,
  needsMeCount,
  userName,
  onNavigate,
}: Props) {
  return (
    <nav className="ent-top-nav" aria-label="主导航">
      {/* 左侧：Logo + 企业名 */}
      <div className="ent-top-nav-brand electron-drag-region">
        <span className="ent-mark" aria-hidden>
          {enterpriseMark}
        </span>
        <strong title={enterpriseName}>{enterpriseName}</strong>
      </div>

      {/* 中间：导航项 */}
      <div className="ent-top-nav-items">
        {NAV_ITEMS.map(item => {
          const Icon = item.icon;
          const active = isActive(item.name, current);
          return (
            <button
              key={item.name}
              type="button"
              className={`ent-top-nav-item${active ? ' active' : ''}`}
              onClick={() => onNavigate(item.route)}
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={16} aria-hidden />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {/* 右侧：搜索/通知/头像 */}
      <div className="ent-top-nav-actions">
        <button
          type="button"
          className="ent-top-nav-icon"
          title="全局搜索"
          aria-label="全局搜索"
        >
          <Search size={18} aria-hidden />
        </button>

        <button
          type="button"
          className="ent-top-nav-icon"
          onClick={() => onNavigate({ name: 'records', bucket: needsMeCount ? 'mine' : 'all' })}
          title={needsMeCount ? `${needsMeCount} 项工作等你处理` : '工作提醒'}
          aria-label={needsMeCount ? `工作提醒，${needsMeCount} 项等你处理` : '工作提醒，暂无待处理'}
        >
          <Bell size={18} aria-hidden />
          {needsMeCount ? <span className="ent-top-nav-dot" aria-hidden /> : null}
        </button>

        <button
          type="button"
          className="ent-top-nav-avatar"
          title={userName}
          aria-label={`${userName}，打开账号菜单`}
        >
          <span className="ent-avatar-text">{userName.slice(0, 1).toUpperCase()}</span>
        </button>
      </div>
    </nav>
  );
}
