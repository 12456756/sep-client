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
    <main className="login-ambient-background bg-[#f7f8fc] relative h-dvh w-screen overflow-hidden text-[#262324]">
      <div className="login-ambient-layer-one" aria-hidden="true" />
      <div className="login-ambient-layer-two" aria-hidden="true" />
      <div className="electron-drag-region fixed inset-x-0 top-0 z-30 h-10" aria-hidden="true" />

      <div className="relative flex h-full overflow-y-auto px-6 py-10 sm:px-10 sm:py-12">
        <section className="my-auto w-full max-w-[400px] mx-auto">
          <header className="mb-9 text-center">
            <h1 className="text-[28px] font-semibold tracking-[0.12em] text-[#332d2f]">
              硅基工作台
            </h1>
            <span className="mx-auto mt-3 block h-[2px] w-8 rounded-full bg-[#6366f1]" aria-hidden="true" />
          </header>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div ref={accountPickerRef} className="relative">
              <label htmlFor="login-email" className="mb-2 block text-xs font-medium text-[#655e60]">
                邮箱
              </label>
              <div className="relative">
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
                  className="h-11 w-full rounded-[8px] border border-[#ded7d8] bg-white/90 px-3.5 pr-20 text-sm text-[#292526] shadow-[0_1px_2px_rgba(72,48,52,0.04)] outline-none transition placeholder:text-[#b8afb1] focus:border-[#6366f1] focus:ring-3 focus:ring-[#6366f1]/10 disabled:bg-white/50"
                />
                {rememberedAccounts.length > 0 && (
                  <button
                    type="button"
                    aria-label="选择历史账号"
                    onClick={() => setAccountsOpen(open => !open)}
                    disabled={loading || deletingEmail !== null}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-[#9e9698] transition hover:bg-[#eef0ff] hover:text-[#4f46e5] focus:outline-none focus:ring-2 focus:ring-[#6366f1]/20"
                  >
                    <ChevronDown className={`h-4 w-4 transition-transform ${accountsOpen ? 'rotate-180' : ''}`} />
                  </button>
                )}
              </div>

              {accountsOpen && filteredAccounts.length > 0 && (
                <div
                  id="remembered-account-list"
                  role="listbox"
                  className="absolute z-20 mt-2 max-h-56 w-full overflow-y-auto rounded-[9px] border border-[#e3dcdd] bg-white p-1.5 shadow-[0_16px_40px_rgba(74,45,50,0.14),0_3px_10px_rgba(74,45,50,0.06)]"
                >
                  {filteredAccounts.map((account, index) => (
                    <div
                      key={account.email}
                      role="option"
                      aria-selected={selectedEmail === account.email}
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => selectAccount(account)}
                      className={`group flex h-[52px] cursor-pointer items-center gap-3 rounded-[7px] px-3 transition ${index === activeAccountIndex || selectedEmail === account.email ? 'bg-[#eef0ff]' : 'hover:bg-[#f5f6ff]'}`}
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#eef0ff] text-xs font-semibold text-[#4f46e5]">
                        {(account.displayName || account.email).slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 truncate text-xs font-medium text-[#3c3638]">
                          <span className="truncate">{account.displayName || account.email}</span>
                          {encryptionAvailable && account.hasSavedPassword && (
                            <LockKeyhole className="h-3 w-3 shrink-0 text-[#818cf8]" />
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-[#958c8e]">{account.email}</span>
                      </span>
                      <button
                        type="button"
                        aria-label={`移除 ${account.email}`}
                        title={deletingEmail === account.email ? '正在移除…' : '移除账号及保存的密码'}
                        onClick={event => void handleForgetAccount(event, account.email)}
                        disabled={loading || deletingEmail !== null}
                        className="rounded-md p-1.5 text-[#aaa2a4] transition hover:bg-[#e0e7ff] hover:text-[#4f46e5] focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-[#6366f1]/20 group-hover:opacity-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label htmlFor="login-password" className="mb-2 block text-xs font-medium text-[#655e60]">
                密码
              </label>
              <div className="relative">
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
                  className="h-11 w-full rounded-[8px] border border-[#ded7d8] bg-white/90 px-3.5 pr-20 text-sm text-[#292526] shadow-[0_1px_2px_rgba(72,48,52,0.04)] outline-none transition placeholder:text-[#b8afb1] focus:border-[#6366f1] focus:ring-3 focus:ring-[#6366f1]/10 disabled:bg-white/50"
                />
                <button
                  type="button"
                  aria-pressed={showPassword}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  onClick={() => void togglePassword()}
                  disabled={loading || revealing || (!hasSavedPassword && !password)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-[#9e9698] transition hover:bg-[#eef0ff] hover:text-[#7d7375] focus:outline-none focus:ring-2 focus:ring-[#6366f1]/20 disabled:opacity-35"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
                {(hasSavedPassword || password) && <button type="button" aria-label="清空密码"
                  disabled={loading} onClick={clearPassword}
                  className="absolute right-10 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-slate-500 hover:bg-indigo-50 focus-visible:ring-2 focus-visible:ring-indigo-500">
                  <X className="h-4 w-4" />
                </button>}
              </div>
            </div>

            {notice && <p role="status" className="text-xs text-indigo-600">{notice}</p>}

            {errorKind && (
              <div role="alert" className="flex items-center gap-2 text-xs text-[#b33437]">
                {errorKind === 'network' ? <WifiOff className="h-3.5 w-3.5 shrink-0" /> : <AlertCircle className="h-3.5 w-3.5 shrink-0" />}
                <span>{errorCopy[errorKind]}</span>
              </div>
            )}

            <div className="flex min-h-5 items-center justify-between gap-4 pt-1">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-[#6f6769]">
                <input
                  type="checkbox"
                  checked={rememberPassword}
                  onChange={event => setRememberPassword(event.target.checked)}
                  disabled={loading || !encryptionAvailable}
                  className="h-4 w-4 rounded border-[#c7bec0] accent-[#6366f1]"
                />
                记住密码
              </label>
              {!encryptionAvailable && (
                <span className="text-[11px] text-[#9b6b6d]">系统安全存储不可用</span>
              )}
            </div>

            <button
              ref={submitButtonRef}
              type="submit"
              disabled={loading || revealing || deletingEmail !== null || !canSubmit}
              className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-[8px] bg-[#6366f1] text-sm font-semibold text-white shadow-[0_7px_18px_rgba(99,102,241,0.2)] transition hover:bg-[#4f46e5] hover:shadow-[0_9px_22px_rgba(99,102,241,0.25)] focus:outline-none focus:ring-3 focus:ring-[#6366f1]/20 active:translate-y-px disabled:cursor-not-allowed disabled:bg-[#a5b4fc] disabled:shadow-none"
            >
              {loading ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  登录中
                </>
              ) : (
                <>
                  <KeyRound className="h-4 w-4" />
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
