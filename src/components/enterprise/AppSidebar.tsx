/**
 * 左侧主导航。只有五个入口，全部用业务语言命名。
 * 企业管理类入口仅对有权限的成员显示，普通成员看不到。
 *
 * 账号入口放在最下方：它不是常用操作，放侧栏底部既不占顶栏，
 * 也不会和页面标题争夺注意力。菜单向上弹出，避免被窗口底边裁掉。
 */

import { Building2, ChevronUp, ClipboardList, GraduationCap, Home, LogOut, Settings, ShieldCheck, Users, Workflow } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AppRoute, AppRouteName } from '../../features/enterprise/types';
import { EmployeeAvatar } from './atoms';

interface Props {
  enterpriseName: string;
  enterpriseMark: string;
  current: AppRouteName;
  /** 待我处理的结果数，出现在「工作记录」右侧。 */
  needsMeCount: number;
  /** 是否为企业管理员。普通成员不显示管理入口。 */
  canManage: boolean;
  userName: string;
  onNavigate: (route: AppRoute) => void;
  onLogout: () => void;
}

const MAIN: { name: AppRouteName; label: string; icon: typeof Home; route: AppRoute }[] = [
  { name: 'home', label: '首页', icon: Home, route: { name: 'home' } },
  { name: 'employees', label: '硅基员工', icon: Users, route: { name: 'employees' } },
  { name: 'arrange', label: '安排工作', icon: Workflow, route: { name: 'arrange' } },
  { name: 'records', label: '工作记录', icon: ClipboardList, route: { name: 'records' } },
  { name: 'skills', label: '员工技能', icon: GraduationCap, route: { name: 'skills' } },
];

export function AppSidebar({ enterpriseName, enterpriseMark, current, needsMeCount, canManage, userName, onNavigate, onLogout }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const account = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!account.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  return (
    <nav className="ent-side" aria-label="主导航">
      <div className="ent-side-brand">
        <span className="ent-mark" aria-hidden>{enterpriseMark}</span>
        <strong title={enterpriseName}>{enterpriseName}</strong>
      </div>
      {MAIN.map(item => {
        const Icon = item.icon;
        const showCount = item.name === 'records' && needsMeCount > 0;
        return (
          <button
            key={item.name}
            type="button"
            className={`ent-nav-item${current === item.name || (item.name === 'employees' && current === 'employee') || (item.name === 'records' && current === 'work') ? ' active' : ''}`}
            onClick={() => onNavigate(item.route)}
            aria-current={current === item.name ? 'page' : undefined}
          >
            <Icon size={16} aria-hidden />
            {item.label}
            {showCount ? <span className="ent-nav-count">{needsMeCount}</span> : null}
          </button>
        );
      })}
      {canManage ? (
        <>
          <div className="ent-nav-group">企业管理</div>
          <button type="button" className="ent-nav-item" onClick={() => onNavigate({ name: 'skills' })}>
            <ShieldCheck size={16} aria-hidden />
            技能审核
          </button>
          <button type="button" className="ent-nav-item" onClick={() => onNavigate({ name: 'employees' })}>
            <Building2 size={16} aria-hidden />
            员工权限
          </button>
        </>
      ) : null}

      <div className="ent-side-account" ref={account}>
        <button type="button" className="ent-side-user" onClick={() => setMenuOpen(value => !value)} aria-expanded={menuOpen} aria-haspopup="menu">
          <EmployeeAvatar mark={userName.slice(0, 1)} size="sm" />
          <strong title={userName}>{userName}</strong>
          <ChevronUp size={13} aria-hidden style={{ transform: menuOpen ? 'rotate(180deg)' : undefined }} />
        </button>
        {menuOpen ? (
          <div className="ent-side-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => setMenuOpen(false)}>
              <Settings size={13} aria-hidden />
              设置
            </button>
            <button type="button" role="menuitem" className="danger" onClick={() => { setMenuOpen(false); onLogout(); }}>
              <LogOut size={13} aria-hidden />
              退出登录
            </button>
          </div>
        ) : null}
      </div>
    </nav>
  );
}
