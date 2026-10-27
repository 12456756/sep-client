import { BookOpen, Building2, CircleUserRound, Gauge, LayoutGrid, ListTodo, LogOut, Settings, Users, Workflow } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import type { AppRoute, AppRouteName } from '../../features/enterprise/types';
import type { EmployeeAvatarSource } from '../../shared/types';
import { EmployeeFace } from './EmployeeFace';
import { IconHint } from './IconHint';
import './icon-navigation.css';

interface Props {
  enterpriseName: string;
  enterpriseMark?: string;
  enterpriseLogo?: string | null;
  current: AppRouteName;
  needsMeCount: number;
  canManage: boolean;
  userName: string;
  userAvatar?: EmployeeAvatarSource | null;
  collapsed?: boolean;
  onNavigate: (route: AppRoute) => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}

const MAIN: { name: AppRouteName; label: string; icon: typeof Users; route: AppRoute }[] = [
  { name: 'home', label: '首页', icon: LayoutGrid, route: { name: 'home' } },
  { name: 'records', label: '工作', icon: Workflow, route: { name: 'records' } },
  { name: 'employees', label: '硅基员工', icon: Users, route: { name: 'employees' } },
  { name: 'skills', label: '员工技能', icon: ListTodo, route: { name: 'skills' } },
  { name: 'knowledge', label: '知识库', icon: BookOpen, route: { name: 'knowledge' } },
  { name: 'compute-center', label: '算力中心', icon: Gauge, route: { name: 'compute-center' } },
];

function isActive(item: AppRouteName, current: AppRouteName): boolean {
  if (item === 'records') return current === 'arrange' || current === 'records' || current === 'work';
  if (item === current) return true;
  return item === 'employees' && current === 'employee';
}

export function AppSideNav({
  enterpriseName, enterpriseLogo, current, needsMeCount, canManage, userName, userAvatar, collapsed = true, onNavigate, onOpenSettings, onLogout,
}: Props): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [enterpriseMenuOpen, setEnterpriseMenuOpen] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const account = useRef<HTMLDivElement>(null);
  const enterprise = useRef<HTMLDivElement>(null);
  const accountTrigger = useRef<HTMLButtonElement>(null);
  const enterpriseTrigger = useRef<HTMLButtonElement>(null);
  const accountMenu = useRef<HTMLDivElement>(null);
  const enterpriseMenu = useRef<HTMLDivElement>(null);

  useEffect(() => setLogoFailed(false), [enterpriseLogo]);

  useEffect(() => {
    if (!menuOpen && !enterpriseMenuOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!account.current?.contains(target)) setMenuOpen(false);
      if (!enterprise.current?.contains(target)) setEnterpriseMenuOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        setEnterpriseMenuOpen(false);
        if (menuOpen) accountTrigger.current?.focus();
        if (enterpriseMenuOpen) enterpriseTrigger.current?.focus();
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [menuOpen, enterpriseMenuOpen]);

  useEffect(() => {
    if (menuOpen) accountMenu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    if (enterpriseMenuOpen) enterpriseMenu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menuOpen, enterpriseMenuOpen]);

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, menu: RefObject<HTMLDivElement | null>): void {
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  }

  const brandContent = <>
    {enterpriseLogo && !logoFailed ? <img className="ent-enterprise-logo" src={enterpriseLogo} alt="" onError={() => setLogoFailed(true)} /> : <Building2 size={22} aria-hidden />}
    {!collapsed ? <span className="ent-icon-label">{enterpriseName}</span> : null}
  </>;


  return (
    <nav className={`ent-side ent-icon-nav${collapsed ? ' collapsed' : ''}`} aria-label="主导航">
      <div className="ent-side-brand ent-icon-brand electron-no-drag" ref={enterprise}>
        <IconHint label={enterpriseName}>
          {canManage ? <button
            type="button"
            ref={enterpriseTrigger}
            className="ent-icon-brand-button"
            aria-label={`${enterpriseName}，打开企业菜单`}
            aria-expanded={enterpriseMenuOpen}
            aria-haspopup="menu"
            onClick={() => { setMenuOpen(false); setEnterpriseMenuOpen(value => !value); }}
          >
            {brandContent}
          </button> : <span className="ent-icon-brand-button" tabIndex={0} role="img" aria-label={enterpriseName}>{brandContent}</span>}
        </IconHint>
        {canManage && enterpriseMenuOpen ? (
          <div className="ent-icon-menu ent-enterprise-menu" role="menu" ref={enterpriseMenu} onKeyDown={event => handleMenuKeyDown(event, enterpriseMenu)}>
            <strong>{enterpriseName}</strong>
            <button type="button" role="menuitem" onClick={() => { setEnterpriseMenuOpen(false); onNavigate({ name: 'employees' }); }}>员工管理</button>
            <button type="button" role="menuitem" onClick={() => { setEnterpriseMenuOpen(false); onNavigate({ name: 'skills' }); }}>技能管理</button>
          </div>
        ) : null}
      </div>

      <div className="ent-side-items ent-icon-items" id="ent-primary-navigation">
        {MAIN.map(item => {
          const Icon = item.icon;
          const active = isActive(item.name, current);
          const label = item.name === 'records' && needsMeCount > 0 ? `${item.label}，${needsMeCount} 项待处理` : item.label;
          return (
            <IconHint key={item.name} label={label}>
              <button type="button" className={`ent-nav-item ent-icon-nav-item${active ? ' active' : ''}`} onClick={() => { if (!active) onNavigate(item.route); }} aria-label={label} aria-current={active ? 'page' : undefined}>
                <Icon size={20} strokeWidth={1.8} aria-hidden />
                {!collapsed ? <span className="ent-icon-label">{item.label}</span> : null}
                {item.name === 'records' && needsMeCount > 0 ? <span className="ent-icon-count" aria-hidden>{needsMeCount > 99 ? '99+' : needsMeCount}</span> : null}
              </button>
            </IconHint>
          );
        })}
      </div>

      <div className="ent-side-account ent-icon-account" ref={account}>
        <IconHint label={userName}>
          <button type="button" ref={accountTrigger} className="ent-side-user ent-icon-account-button" onClick={() => { setEnterpriseMenuOpen(false); setMenuOpen(value => !value); }} aria-expanded={menuOpen} aria-haspopup="menu" aria-label={`${userName}，打开账号菜单`}>
            <EmployeeFace employee={userAvatar} name={userName} size="sm" round />
            <CircleUserRound className="ent-icon-account-fallback" size={20} aria-hidden />
            {!collapsed ? <span className="ent-icon-label">{userName}</span> : null}
          </button>
        </IconHint>
        {menuOpen ? (
          <div className="ent-icon-menu ent-side-menu" role="menu" ref={accountMenu} onKeyDown={event => handleMenuKeyDown(event, accountMenu)}>
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpenSettings(); }}><Settings size={14} aria-hidden />设置</button>
            <button type="button" role="menuitem" className="danger" onClick={() => { setMenuOpen(false); onLogout(); }}><LogOut size={14} aria-hidden />退出登录</button>
          </div>
        ) : null}
      </div>
    </nav>
  );
}
