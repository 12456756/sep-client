/**
 * 顶部主导航：企业名在左，入口在中间，提醒和账号在右。
 *
 * 入口和原来的侧栏一字不差，只是从竖排改成横排 —— 窗口最窄 960，
 * 横排省下的一整列宽度直接给了员工墙。入口只写文字不带图标：
 * 五个入口 + 企业名 + 账号要在 960 里排开，图标是这里第一个该省的东西。
 *
 * 它同时承担 Electron 的窗口拖拽区。Windows 的窗口按钮由 titleBarOverlay
 * 画在右上角，所以右侧要按 env(titlebar-area-width) 留白（见 enterprise.css），
 * 否则铃铛和账号会被压在关闭按钮底下点不到。
 */

import { Bell, Building2, ChevronDown, LogOut, Settings, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AppRoute, AppRouteName } from '../../features/enterprise/types';
import { EmployeeFace } from './EmployeeFace';

interface Props {
  enterpriseName: string;
  enterpriseMark: string;
  current: AppRouteName;
  /** 待我确认或需要重试的工作数量，挂在「工作记录」和铃铛上。 */
  needsMeCount: number;
  /** 是否为企业管理员。普通成员看不到管理入口。 */
  canManage: boolean;
  userName: string;
  onNavigate: (route: AppRoute) => void;
  onOpenReminders: () => void;
  onLogout: () => void;
}

const MAIN: { name: AppRouteName; label: string; route: AppRoute }[] = [
  { name: 'home', label: '首页', route: { name: 'home' } },
  { name: 'employees', label: '硅基员工', route: { name: 'employees' } },
  { name: 'arrange', label: '安排工作', route: { name: 'arrange' } },
  { name: 'records', label: '工作记录', route: { name: 'records' } },
  { name: 'skills', label: '员工技能', route: { name: 'skills' } },
];

/** 详情页算在它的列表页下面：员工详情亮「硅基员工」，工作详情亮「工作记录」。 */
function isActive(item: AppRouteName, current: AppRouteName): boolean {
  if (item === current) return true;
  if (item === 'employees') return current === 'employee';
  if (item === 'records') return current === 'work';
  return false;
}

export function AppNavBar({
  enterpriseName, enterpriseMark, current, needsMeCount, canManage, userName, onNavigate, onOpenReminders, onLogout,
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
    <header className="ent-topnav electron-drag-region">
      <div className="ent-topnav-brand">
        <span className="ent-mark" aria-hidden>{enterpriseMark}</span>
        <strong title={enterpriseName}>{enterpriseName}</strong>
      </div>

      <nav className="ent-topnav-items" aria-label="主导航">
        {MAIN.map(item => {
          const active = isActive(item.name, current);
          return (
            <button
              key={item.name}
              type="button"
              className={`ent-topnav-item${active ? ' active' : ''}`}
              onClick={() => onNavigate(item.route)}
              aria-current={active ? 'page' : undefined}
            >
              {item.label}
              {item.name === 'records' && needsMeCount ? <em className="ent-topnav-count">{needsMeCount}</em> : null}
            </button>
          );
        })}
        {canManage ? (
          <>
            <span className="ent-topnav-sep" aria-hidden />
            <button type="button" className="ent-topnav-item" onClick={() => onNavigate({ name: 'skills' })}>
              <ShieldCheck size={14} aria-hidden />
              技能审核
            </button>
            <button type="button" className="ent-topnav-item" onClick={() => onNavigate({ name: 'employees' })}>
              <Building2 size={14} aria-hidden />
              员工权限
            </button>
          </>
        ) : null}
      </nav>

      <div className="ent-topnav-right">
        <button
          type="button"
          className="ent-top-icon"
          onClick={onOpenReminders}
          title={needsMeCount ? `${needsMeCount} 项工作等你处理` : '暂无待处理的工作'}
          aria-label={needsMeCount ? `${needsMeCount} 项工作等你处理` : '暂无待处理的工作'}
        >
          <Bell size={16} aria-hidden />
          {needsMeCount ? <span className="ent-dot" /> : null}
        </button>
        <div className="ent-topnav-user" ref={account}>
          <button
            type="button"
            className="ent-topnav-account"
            onClick={() => setMenuOpen(value => !value)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            <EmployeeFace name={userName} size="sm" round />
            <strong title={userName}>{userName}</strong>
            <ChevronDown size={13} aria-hidden style={{ transform: menuOpen ? 'rotate(180deg)' : undefined }} />
          </button>
          {menuOpen ? (
            <div className="ent-user-menu" role="menu">
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
      </div>
    </header>
  );
}
