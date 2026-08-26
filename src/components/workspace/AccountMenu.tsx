import { Building2, Check, ChevronDown, CircleUserRound, LogOut, RefreshCw, Settings2, WalletCards } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface Props { userName: string; email?: string; enterpriseName?: string; onLogout: () => void }

export function AccountMenu({ userName, email, enterpriseName, onLogout }: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className="account-menu-wrap" ref={menuRef}>
      {open && <div className="account-menu" role="menu">
        <div className="account-menu-heading"><span className="account-avatar"><CircleUserRound size={18} /></span><span><strong>{userName}</strong><small>{email}</small></span></div>
        <div className="account-menu-company"><Building2 size={15} /><span>{enterpriseName || '当前企业'}</span></div>
        <div className="account-menu-usage"><WalletCards size={15} /><span>本月额度</span><strong>由平台提供</strong></div>
        <button role="menuitem" onClick={() => undefined} title="检查更新"><RefreshCw size={15} />检查更新</button>
        <button role="menuitem" onClick={() => undefined} title="打开设置"><Settings2 size={15} />设置</button>
        <button role="menuitem" className="danger" onClick={onLogout} title="退出登录"><LogOut size={15} />退出登录</button>
      </div>}
      <button className={`account-trigger ${open ? 'active' : ''}`} onClick={() => setOpen(value => !value)} aria-expanded={open} aria-label="打开账户菜单" title="打开账户菜单">
        <span className="account-avatar"><CircleUserRound size={18} /></span>
        <span className="account-trigger-copy"><strong>{userName}</strong><small>{enterpriseName || '个人工作台'}</small></span>
        <ChevronDown size={15} className={open ? 'rotate-180' : ''} />
      </button>
    </div>
  );
}
