import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowUpRight,
  ChevronDown,
  Eye,
  EyeOff,
  LockKeyhole,
  Mail,
  ShieldCheck,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import type { AuthErrorCode, RememberedAccount } from '../shared/types';
import logoImage from '../assets/logo.png';

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
    <main className="login-page">
      <section className="login-brand-panel" aria-label="硅基员工平台产品介绍">
        <div className="login-brand-glow login-brand-glow-primary" aria-hidden="true" />
        <div className="login-brand-glow login-brand-glow-secondary" aria-hidden="true" />

        <div className="login-brand-content">
          <div className="login-brand-mark">
            <img src={logoImage} alt="硅基员工平台" />
          </div>

          <div className="login-brand-copy">
            <p className="login-brand-name">硅基员工平台</p>
            <h1>让每一位员工，<br /><em>都有一个 AI 同行者</em></h1>
            <p className="login-brand-description">
              数字员工平台，让团队把时间留给更有价值的创造。
            </p>
          </div>

          <p className="login-brand-values" aria-label="产品特点">
            <span>AI 驱动</span>
            <i aria-hidden="true">·</i>
            <span>智能协作</span>
            <i aria-hidden="true">·</i>
            <span>安全可信</span>
          </p>
        </div>
      </section>

      <section className="login-form-panel">
        <div className="login-form-shell">
          <div className="login-mobile-brand" aria-hidden="true">
            <img src={logoImage} alt="" />
            <span>硅基员工平台</span>
          </div>

          <header className="login-form-header">
            <p className="login-form-eyebrow">欢迎回来</p>
            <h2>登录硅基员工平台</h2>
            <p>进入你的数字员工工作台</p>
          </header>

          <form onSubmit={handleSubmit} className="login-form">
            <div ref={accountPickerRef} className="login-field login-account-field">
              <div className="login-field-label-row">
                <label htmlFor="login-email">邮箱</label>
                <span>Work email</span>
              </div>
              <div className="login-input-wrap">
                <Mail className="login-input-leading-icon" size={17} strokeWidth={1.8} aria-hidden="true" />
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
                  className="login-input login-input-with-leading login-input-with-trailing"
                />
                {rememberedAccounts.length > 0 && (
                  <button
                    type="button"
                    aria-label="选择历史账号"
                    onClick={() => setAccountsOpen(open => !open)}
                    disabled={loading || deletingEmail !== null}
                    className="login-input-action"
                  >
                    <ChevronDown className={accountsOpen ? 'rotate-180' : ''} size={16} />
                  </button>
                )}
              </div>

              {accountsOpen && filteredAccounts.length > 0 && (
                <div id="remembered-account-list" role="listbox" className="login-account-menu">
                  {filteredAccounts.map((account, index) => (
                    <div
                      key={account.email}
                      role="option"
                      aria-selected={selectedEmail === account.email}
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => selectAccount(account)}
                      className={`login-account-option ${index === activeAccountIndex || selectedEmail === account.email ? 'is-active' : ''}`}
                    >
                      <span className="login-account-avatar">
                        {(account.displayName || account.email).slice(0, 1).toUpperCase()}
                      </span>
                      <span className="login-account-copy">
                        <span className="login-account-name">
                          <span>{account.displayName || account.email}</span>
                          {encryptionAvailable && account.hasSavedPassword && <LockKeyhole size={12} aria-label="已保存密码" />}
                        </span>
                        <span className="login-account-email">{account.email}</span>
                      </span>
                      <button
                        type="button"
                        aria-label={`移除 ${account.email}`}
                        title={deletingEmail === account.email ? '正在移除…' : '移除账号及保存的密码'}
                        onClick={event => void handleForgetAccount(event, account.email)}
                        disabled={loading || deletingEmail !== null}
                        className="login-account-remove"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="login-field">
              <div className="login-field-label-row">
                <label htmlFor="login-password">密码</label>
                <span>Password</span>
              </div>
              <div className="login-input-wrap">
                <LockKeyhole className="login-input-leading-icon" size={17} strokeWidth={1.8} aria-hidden="true" />
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
                  className="login-input login-input-with-leading login-input-with-trailing"
                />
                {(hasSavedPassword || password) && (
                  <button type="button" aria-label="清空密码" disabled={loading} onClick={clearPassword} className="login-input-clear">
                    <X size={15} />
                  </button>
                )}
                <button
                  type="button"
                  aria-pressed={showPassword}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  onClick={() => void togglePassword()}
                  disabled={loading || revealing || (!hasSavedPassword && !password)}
                  className="login-input-action login-password-toggle"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {notice && <p role="status" className="login-notice">{notice}</p>}

            {errorKind && (
              <div role="alert" className="login-error">
                {errorKind === 'network' ? <WifiOff size={15} aria-hidden="true" /> : <AlertCircle size={15} aria-hidden="true" />}
                <span>{errorCopy[errorKind]}</span>
              </div>
            )}

            <div className="login-form-options">
              <label className="login-remember-option">
                <input
                  type="checkbox"
                  checked={rememberPassword}
                  onChange={event => setRememberPassword(event.target.checked)}
                  disabled={loading || !encryptionAvailable}
                />
                <span>记住密码</span>
              </label>
              {!encryptionAvailable && <span className="login-storage-warning">系统安全存储不可用</span>}
            </div>

            <button
              ref={submitButtonRef}
              type="submit"
              disabled={loading || revealing || deletingEmail !== null || !canSubmit}
              className="login-submit"
            >
              {loading ? (
                <>
                  <span className="login-submit-spinner" />
                  登录中
                </>
              ) : (
                <>
                  登录
                  <ArrowUpRight size={17} strokeWidth={2.1} />
                </>
              )}
            </button>
          </form>

          <footer className="login-form-footer">
            <ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>你的数据将通过安全连接传输</span>
          </footer>
        </div>
      </section>
    </main>
  );
};
