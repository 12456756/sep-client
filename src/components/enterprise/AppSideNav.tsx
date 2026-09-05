/**
 * 左侧主导航。固定在左边、通高，永远不移到顶部。
 *
 * 自上而下三段：企业标记与名称、五个入口、账号。账号固定贴底，
 * 菜单向上弹出，避免被窗口底边裁掉。企业管理类入口只对有权限的成员显示。
 *
 * 「待我处理」的数量挂在「工作记录」上，作为这个入口的注解。顶栏右上角那颗铃铛
 * 指向同一页 —— 数字说明入口现在的情况，铃铛是随时都在的提醒，两者不冲突。
 *
 * 顶部的企业块同时是 Electron 的窗口拖拽区（Windows 的窗口按钮由
 * titleBarOverlay 画在右上角，那一侧的留白见 enterprise.css 的 .ent-top）。
 */

import { Building2, ChevronUp, ClipboardList, GraduationCap, LayoutGrid, ListTodo, LogOut, Settings, ShieldCheck, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AppRoute, AppRouteName } from '../../features/enterprise/types';
import { EmployeeFace } from './EmployeeFace';

interface Props {
  enterpriseName: string;
  enterpriseMark: string;
  current: AppRouteName;
  /** 待我确认或需要重试的工作数量，挂在「工作记录」右侧。 */
  needsMeCount: number;
  /** 是否为企业管理员。普通成员看不到管理入口。 */
  canManage: boolean;
  userName: string;
  onNavigate: (route: AppRoute) => void;
  onLogout: () => void;
}

const MAIN: { name: AppRouteName; label: string; icon: typeof Users; route: AppRoute }[] = [
  { name: 'home', label: '首页', icon: LayoutGrid, route: { name: 'home' } },
  { name: 'employees', label: '硅基员工', icon: Users, route: { name: 'employees' } },
  { name: 'arrange', label: '安排工作', icon: ListTodo, route: { name: 'arrange' } },
  { name: 'records', label: '工作记录', icon: ClipboardList, route: { name: 'records' } },
  { name: 'skills', label: '员工技能', icon: GraduationCap, route: { name: 'skills' } },
];

/** 详情页算在它的列表页下面：员工详情亮「硅基员工」，工作详情亮「工作记录」。 */
function isActive(item: AppRouteName, current: AppRouteName): boolean {
  if (item === current) return true;
  if (item === 'employees') return current === 'employee';
  if (item === 'records') return current === 'work';
  return false;
}

export function AppSideNav({
  enterpriseName, enterpriseMark, current, needsMeCount, canManage, userName, onNavigate, onLogout,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const account = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!account.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [menuOpen]);

  return (
    <nav className="ent-side" aria-label="主导航">
      <div className="ent-side-brand electron-drag-region">
        <span className="ent-mark" aria-hidden>{enterpriseMark}</span>
        <strong title={enterpriseName}>{enterpriseName}</strong>
      </div>

      <div className="ent-side-items">
        {MAIN.map(item => {
          const Icon = item.icon;
          const active = isActive(item.name, current);
          return (
            <button
              key={item.name}
              type="button"
              className={`ent-nav-item${active ? ' active' : ''}`}
              onClick={() => onNavigate(item.route)}
              aria-current={active ? 'page' : undefined}
              title={item.label}
            >
              <Icon size={17} aria-hidden />
              <span>{item.label}</span>
              {item.name === 'records' && needsMeCount ? (
                <em className="ent-nav-count" title={`${needsMeCount} 项工作等你处理`}>{needsMeCount}</em>
              ) : null}
            </button>
          );
        })}

        {canManage ? (
          <>
            <div className="ent-nav-group">企业管理</div>
            <button type="button" className="ent-nav-item" onClick={() => onNavigate({ name: 'skills' })} title="技能审核">
              <ShieldCheck size={17} aria-hidden />
              <span>技能审核</span>
            </button>
            <button type="button" className="ent-nav-item" onClick={() => onNavigate({ name: 'employees' })} title="员工权限">
              <Building2 size={17} aria-hidden />
              <span>员工权限</span>
            </button>
          </>
        ) : null}
      </div>

      <div className="ent-side-account" ref={account}>
        <button
          type="button"
          className="ent-side-user"
          onClick={() => setMenuOpen(value => !value)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <EmployeeFace seed={`user-${userName}`} size="sm" round />
          <span>
            <strong title={userName}>{userName}</strong>
            <small>我的账号</small>
          </span>
          <ChevronUp size={14} aria-hidden style={{ transform: menuOpen ? 'rotate(180deg)' : undefined }} />
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
