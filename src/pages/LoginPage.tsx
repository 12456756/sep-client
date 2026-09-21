/**
 * 登录页。企业外壳之前的第一屏，走暖陶土（ent-*）体系：奶油底 + 两团静态暖光 +
 * 中间一张白卡，标题 Fraunces 衬线。保留记住密码 / 历史账号下拉 / 显示与清空密码 /
 * 二次确认移除账号等全部逻辑。
 *
 * 视觉：enterprise.css 的 .ent-login-* 段。这一屏在 ClientAppPage 之前渲染，所以这里
 * 自己 import enterprise.css（Vite 会把两个懒加载 chunk 的公共 CSS 去重，进壳后不重复）。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import type { AuthErrorCode, RememberedAccount } from '../shared/types';
import '../styles/enterprise.css';

interface LoginPageProps {
  encryptionAvailable: boolean;
  rememberedAccounts: RememberedAccount[];
  onAccountListChange: (accounts: RememberedAccount[]) => void;
  onLoginSuccess: (data: {
    user: { id: string; email: string; name: string };
    enterprise: { id: string; name: string } | null;
  }) => void;
}

type LoginErrorKind = 'validation' | 'credentials' | 'network' | 'service' | 'storage' | 'unknown';

const errorCopy: Record<LoginErrorKind, string> = {
  validation: '请输入有效的邮箱和密码',
  credentials: '邮箱或密码不正确',
  network: '网络连接失败，请稍后重试',
  service: '服务暂时不可用，请稍后重试',
  storage: '系统安全存储不可用',
  unknown: '登录失败，请稍后重试',
};

function classifyLoginError(code: AuthErrorCode | undefined): LoginErrorKind {
  if (code === 'INVALID_ARGUMENT') return 'validation';
  if (code === 'STORAGE_UNAVAILABLE') return 'storage';
  if (code === 'INVALID_CREDENTIALS' || code === 'ACCOUNT_DISABLED') return 'credentials';
  if (code === 'NETWORK_ERROR') return 'network';
  if (code === 'SERVICE_UNAVAILABLE' || code === 'RATE_LIMITED') return 'service';
  return 'unknown';
}

export const LoginPage: React.FC<LoginPageProps> = ({
  encryptionAvailable,
  rememberedAccounts,
  onAccountListChange,
  onLoginSuccess,
}) => {
  const initialAccount = rememberedAccounts[0];
  const [selectedEmail, setSelectedEmail] = useState(initialAccount?.email ?? '');
  const [email, setEmail] = useState(initialAccount?.email ?? '');
  const [password, setPassword] = useState('');
  const [rememberPassword, setRememberPassword] = useState(
    encryptionAvailable && (initialAccount?.hasSavedPassword ?? false),
  );
  const [hasSavedPassword, setHasSavedPassword] = useState(
    encryptionAvailable && (initialAccount?.hasSavedPassword ?? false),
  );
  const [showPassword, setShowPassword] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [activeAccountIndex, setActiveAccountIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [errorKind, setErrorKind] = useState<LoginErrorKind | null>(null);
  const [deletingEmail, setDeletingEmail] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [notice, setNotice] = useState('');
  const credentialRevision = useRef(0);
  const accountPickerRef = useRef<HTMLDivElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);

  const filteredAccounts = useMemo(() => {
    const query = email.trim().toLowerCase();
    if (!query || selectedEmail) return rememberedAccounts;
    return rememberedAccounts.filter(account =>
      `${account.displayName} ${account.email}`.toLowerCase().includes(query),
    );
  }, [email, rememberedAccounts, selectedEmail]);

  useEffect(() => () => { credentialRevision.current += 1; }, []);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!accountPickerRef.current?.contains(event.target as Node)) {
        setAccountsOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  useEffect(() => {
    if (initialAccount && encryptionAvailable && initialAccount.hasSavedPassword) {
      submitButtonRef.current?.focus();
    } else {
      emailInputRef.current?.focus();
    }
  }, [encryptionAvailable, initialAccount]);

  const selectAccount = (account: RememberedAccount) => {
    if (loading || deletingEmail) return;
    credentialRevision.current += 1;
    setRevealing(false);
    setEmail(account.email);
    setPassword('');
    setShowPassword(false);
    setHasSavedPassword(encryptionAvailable && account.hasSavedPassword);
    setRememberPassword(encryptionAvailable && account.hasSavedPassword);
    setErrorKind(null);
    setNotice('');
    setSelectedEmail(account.email);
    setAccountsOpen(false);
    setActiveAccountIndex(0);
  };

  const handleEmailChange = (value: string) => {
    credentialRevision.current += 1;
    setRevealing(false);
    setPassword('');
    setShowPassword(false);
    setNotice('');
    setEmail(value);
    setSelectedEmail('');
    setHasSavedPassword(false);
    setRememberPassword(false);
    setErrorKind(null);
    setActiveAccountIndex(0);
    setAccountsOpen(false);
  };

  const handleEmailKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && filteredAccounts.length > 0) {
      event.preventDefault();
      setAccountsOpen(true);
      setActiveAccountIndex(index => Math.min(index + 1, filteredAccounts.length - 1));
    } else if (event.key === 'ArrowUp' && accountsOpen && filteredAccounts.length > 0) {
      event.preventDefault();
      setActiveAccountIndex(index => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && accountsOpen && filteredAccounts[activeAccountIndex]) {
      event.preventDefault();
      selectAccount(filteredAccounts[activeAccountIndex]);
    } else if (event.key === 'Escape') {
      setAccountsOpen(false);
    }
  };

  const handleForgetAccount = async (
    event: React.MouseEvent<HTMLButtonElement>,
    accountEmail: string,
  ) => {
    event.stopPropagation();
    if (loading || deletingEmail) return;
    setDeletingEmail(accountEmail);
    setErrorKind(null);
    try {
      const result = await window.electronAPI.forgetAccount(accountEmail);
      if (!result.success) throw new Error('Account could not be removed');
      onAccountListChange(rememberedAccounts.filter(account => account.email !== accountEmail));
      if (selectedEmail === accountEmail) {
        handleEmailChange('');
      }
      setNotice('已移除此设备保存的账号和密码');
    } catch {
      setErrorKind('storage');
    } finally {
      setDeletingEmail(null);
    }
  };

  const clearPassword = () => {
    credentialRevision.current += 1;
    setRevealing(false);
    setPassword('');
    setHasSavedPassword(false);
    setShowPassword(false);
    setErrorKind(null);
  };

  const togglePassword = async () => {
    if (!hasSavedPassword) { setShowPassword(value => !value); return; }
    const revision = credentialRevision.current;
    setRevealing(true);
    setErrorKind(null);
    try {
      const result = await window.electronAPI.revealRememberedPassword(email);
      if (revision !== credentialRevision.current) return;
      setPassword(result.password ?? '');
      setHasSavedPassword(false);
      setShowPassword(Boolean(result.password));
      if (!result.password) setNotice('保存的密码已不可用，请重新输入');
    } catch {
      if (revision === credentialRevision.current) setErrorKind('storage');
    } finally {
      if (revision === credentialRevision.current) setRevealing(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setAccountsOpen(false);
    setErrorKind(null);

    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || (!hasSavedPassword && !password)) {
      setErrorKind('validation');
      return;
    }

    credentialRevision.current += 1;
    setRevealing(false);
    setLoading(true);
    try {
      const result = await window.electronAPI.login({
        email: normalizedEmail,
        password: hasSavedPassword && !password ? undefined : password,
        rememberPassword,
        useSavedPassword: hasSavedPassword && !password,
      });

      if (result.success && result.data) {
        onLoginSuccess(result.data);
        return;
      }

      const kind = classifyLoginError(result.error?.code);
      setErrorKind(kind);
      if (kind === 'credentials' && hasSavedPassword) {
        setHasSavedPassword(false);
        setRememberPassword(false);
        setPassword('');
      }
    } catch {
      setErrorKind('unknown');
    } finally {
      setLoading(false);
    }
  };

  const canSubmit = email.trim().length > 0 && (hasSavedPassword || password.length > 0);

  return (
    <main className="ent-login">
      <div className="ent-login-glow" aria-hidden="true" />
      <div className="electron-drag-region ent-login-drag" aria-hidden="true" />

      <div className="ent-login-scroll">
        <section className="ent-login-card">
          <header className="ent-login-head">
            <h1 className="ent-login-title">硅基工作台</h1>
            <span className="ent-login-rule" aria-hidden="true" />
            <p className="ent-login-tag">登录你的企业，开始与硅基员工协作</p>
          </header>

          <form onSubmit={handleSubmit} className="ent-login-form">
            <div ref={accountPickerRef} className="ent-login-field">
              <label htmlFor="login-email" className="ent-login-label">邮箱</label>
              <div className="ent-login-inputwrap">
                <input
                  ref={emailInputRef}
                  id="login-email"
                  role="combobox"
                  aria-expanded={accountsOpen}
                  aria-controls="remembered-account-list"
                  aria-autocomplete="list"
                  type="email"
                  value={email}
                  onChange={event => handleEmailChange(event.target.value)}
                  onKeyDown={handleEmailKeyDown}
                  placeholder="name@company.com"
                  autoComplete="email"
                  disabled={loading || deletingEmail !== null}
                  className="ent-login-input"
                />
                {rememberedAccounts.length > 0 && (
                  <button
                    type="button"
                    aria-label="选择历史账号"
                    onClick={() => setAccountsOpen(open => !open)}
                    disabled={loading || deletingEmail !== null}
                    className={`ent-login-affix caret${accountsOpen ? ' open' : ''}`}
                  >
                    <ChevronDown size={16} aria-hidden />
                  </button>
                )}
              </div>

              {accountsOpen && filteredAccounts.length > 0 && (
                <div id="remembered-account-list" role="listbox" className="ent-login-accounts">
                  {filteredAccounts.map((account, index) => (
                    <div
                      key={account.email}
                      role="option"
                      aria-selected={selectedEmail === account.email}
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => selectAccount(account)}
                      className={`ent-login-account${index === activeAccountIndex ? ' active' : ''}${selectedEmail === account.email ? ' selected' : ''}`}
                    >
                      <span className="ent-login-account-avatar" aria-hidden>
                        {(account.displayName || account.email).slice(0, 1).toUpperCase()}
                      </span>
                      <span className="ent-login-account-meta">
                        <span className="ent-login-account-name">
                          <span>{account.displayName || account.email}</span>
                          {encryptionAvailable && account.hasSavedPassword && (
                            <LockKeyhole size={12} aria-hidden />
                          )}
                        </span>
                        <span className="ent-login-account-email">{account.email}</span>
                      </span>
                      <button
                        type="button"
                        aria-label={`移除 ${account.email}`}
                        title={deletingEmail === account.email ? '正在移除…' : '移除账号及保存的密码'}
                        onClick={event => void handleForgetAccount(event, account.email)}
                        disabled={loading || deletingEmail !== null}
                        className="ent-login-account-del"
                      >
                        <Trash2 size={14} aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="ent-login-field">
              <label htmlFor="login-password" className="ent-login-label">密码</label>
              <div className="ent-login-inputwrap">
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  value={hasSavedPassword ? '••••••••' : password}
                  onChange={event => {
                    credentialRevision.current += 1;
                    setRevealing(false);
                    setPassword(hasSavedPassword ? event.target.value.replace('••••••••', '') : event.target.value);
                    setHasSavedPassword(false);
                    setErrorKind(null);
                  }}
                  onFocus={event => { if (hasSavedPassword) event.target.select(); }}
                  onKeyDown={event => {
                    if (hasSavedPassword && (event.key === 'Backspace' || event.key === 'Delete')) {
                      event.preventDefault();
                      clearPassword();
                    }
                  }}
                  placeholder="请输入密码"
                  autoComplete="current-password"
                  disabled={loading || deletingEmail !== null}
                  className="ent-login-input"
                />
                <button
                  type="button"
                  aria-pressed={showPassword}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  onClick={() => void togglePassword()}
                  disabled={loading || revealing || (!hasSavedPassword && !password)}
                  className="ent-login-affix eye"
                >
                  {showPassword ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
                </button>
                {(hasSavedPassword || password) && (
                  <button
                    type="button"
                    aria-label="清空密码"
                    disabled={loading}
                    onClick={clearPassword}
                    className="ent-login-affix clear"
                  >
                    <X size={16} aria-hidden />
                  </button>
                )}
              </div>
            </div>

            {notice && <p role="status" className="ent-login-notice">{notice}</p>}

            {errorKind && (
              <div role="alert" className="ent-login-error">
                {errorKind === 'network' ? <WifiOff size={14} aria-hidden /> : <AlertCircle size={14} aria-hidden />}
                <span>{errorCopy[errorKind]}</span>
              </div>
            )}

            <div className="ent-login-remember-row">
              <label className="ent-login-remember">
                <input
                  type="checkbox"
                  checked={rememberPassword}
                  onChange={event => setRememberPassword(event.target.checked)}
                  disabled={loading || !encryptionAvailable}
                  className="ent-login-check"
                />
                记住密码
              </label>
              {!encryptionAvailable && (
                <span className="ent-login-storage-warn">系统安全存储不可用</span>
              )}
            </div>

            <button
              ref={submitButtonRef}
              type="submit"
              disabled={loading || revealing || deletingEmail !== null || !canSubmit}
              className="ent-login-submit"
            >
              {loading ? (
                <>
                  <span className="ent-login-spinner" aria-hidden />
                  登录中
                </>
              ) : (
                <>
                  <KeyRound size={16} aria-hidden />
                  登录
                </>
              )}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
};
