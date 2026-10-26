import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  ChevronDown,
  Eye,
  EyeOff,
  LockKeyhole,
  Mail,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import type { RememberedAccount } from '../shared/types';
import { LOGIN_FEEDBACK } from '../shared/login-feedback';
import { useFeedback } from '../components/feedback/FeedbackProvider';
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

export const LoginPage: React.FC<LoginPageProps> = ({
  encryptionAvailable,
  rememberedAccounts,
  onAccountListChange,
  onLoginSuccess,
}) => {
  const feedback = useFeedback();
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
  const [deletingEmail, setDeletingEmail] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const credentialRevision = useRef(0);
  const accountPickerRef = useRef<HTMLDivElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);

  const filteredAccounts = useMemo(() => {
    const query = email.trim().toLowerCase();
    if (!query || selectedEmail) return rememberedAccounts;
    return rememberedAccounts.filter(account =>
      `${account.displayName} ${account.email}`.toLowerCase().includes(query),
    );
  }, [email, rememberedAccounts, selectedEmail]);

  useEffect(() => () => { credentialRevision.current += 1; }, []);
  useEffect(() => {
    if (!encryptionAvailable) feedback.show({ tone: 'warning', message: LOGIN_FEEDBACK.storage_unavailable.message });
  }, [encryptionAvailable, feedback]);

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
    feedback.clear();
    setSelectedEmail(account.email);
    setAccountsOpen(false);
    setActiveAccountIndex(0);
  };

  const handleEmailChange = (value: string, clearFeedback = true) => {
    credentialRevision.current += 1;
    setRevealing(false);
    setPassword('');
    setShowPassword(false);
    if (clearFeedback) feedback.clear();
    setEmail(value);
    setSelectedEmail('');
    setHasSavedPassword(false);
    setRememberPassword(false);
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

  const handleForgetAccount = (
    event: React.MouseEvent<HTMLButtonElement>,
    accountEmail: string,
  ) => {
    event.stopPropagation();
    if (loading || deletingEmail) return;
    setAccountsOpen(false);
    const revision = credentialRevision.current;
    const session = feedback.getRevision();
    const isCurrent = () => revision === credentialRevision.current && session === feedback.getRevision();
    void feedback.confirm({
      title: '移除历史账号',
      message: `确认移除 ${accountEmail}？此设备保存的账号和密码将被删除。`,
      actionLabel: '移除', busyLabel: '正在移除', key: `forget:${accountEmail}`,
      onConfirm: async () => {
        if (!isCurrent()) return { success: false, message: LOGIN_FEEDBACK.account_remove.message };
        setDeletingEmail(accountEmail);
        try {
          const result = await window.electronAPI.forgetAccount(accountEmail);
          if (!isCurrent()) return { success: false, message: LOGIN_FEEDBACK.account_remove.message };
          if (!result.success) return { success: false, message: result.error?.message ?? LOGIN_FEEDBACK.account_remove.message };
          onAccountListChange(rememberedAccounts.filter(account => account.email !== accountEmail));
          if (selectedEmail === accountEmail) handleEmailChange('', false);
          return { success: true, message: '已移除此设备保存的账号和密码' };
        } catch {
          return { success: false, message: LOGIN_FEEDBACK.account_remove.message };
        } finally { if (session === feedback.getRevision()) setDeletingEmail(null); }
      },
    });
  };

  const clearPassword = () => {
    credentialRevision.current += 1;
    setRevealing(false);
    setPassword('');
    setHasSavedPassword(false);
    setShowPassword(false);
  };

  const togglePassword = async () => {
    if (!hasSavedPassword) { setShowPassword(value => !value); return; }
    const revision = credentialRevision.current;
    setRevealing(true);
    const session = feedback.getRevision();
    try {
      const result = await window.electronAPI.revealRememberedPassword(email);
      if (revision !== credentialRevision.current || session !== feedback.getRevision()) return;
      if (result.error) {
        feedback.show({ tone: 'error', message: result.error.message });
        return;
      }
      setPassword(result.password ?? '');
      setHasSavedPassword(false);
      setShowPassword(Boolean(result.password));
      if (!result.password) feedback.show({ tone: 'warning', message: LOGIN_FEEDBACK.saved_password_missing.message });
    } catch {
      if (revision === credentialRevision.current && session === feedback.getRevision()) feedback.show({ tone: 'error', message: LOGIN_FEEDBACK.password_read.message });
    } finally {
      if (revision === credentialRevision.current) setRevealing(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current || loading || revealing || deletingEmail) return;
    setAccountsOpen(false);

    const normalizedEmail = email.trim().toLowerCase();
    const validation = !normalizedEmail ? 'email_required'
      : normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) ? 'email_invalid'
      : !hasSavedPassword && !password ? 'password_required' : null;
    if (validation) {
      feedback.show({ tone: 'warning', message: LOGIN_FEEDBACK[validation].message });
      return;
    }

    credentialRevision.current += 1;
    const revision = credentialRevision.current;
    const session = feedback.getRevision();
    const isCurrent = () => revision === credentialRevision.current && session === feedback.getRevision();
    submitting.current = true;
    setRevealing(false);
    setLoading(true);
    try {
      const result = await window.electronAPI.login({
        email: normalizedEmail,
        password: hasSavedPassword && !password ? undefined : password,
        rememberPassword,
        useSavedPassword: hasSavedPassword && !password,
      });
      if (!isCurrent()) return;

      if (result.success && result.data) {
        onLoginSuccess(result.data);
        return;
      }

      feedback.show({ tone: 'error', message: result.error?.message ?? LOGIN_FEEDBACK.unknown.message });
      if ((result.error?.reason === 'credentials' || result.error?.reason === 'saved_password_missing') && hasSavedPassword) {
        setHasSavedPassword(false);
        setRememberPassword(false);
        setPassword('');
      }
    } catch {
      if (isCurrent()) feedback.show({ tone: 'error', message: LOGIN_FEEDBACK.unknown.message });
    } finally {
      submitting.current = false;
      if (revision === credentialRevision.current) setLoading(false);
    }
  };

  return (
    <main className="login-page">
      <div className="login-container">
        <div className="login-card">
          <section className="login-brand-panel" aria-label="硅基员工平台">
            <img className="login-brand-watermark" src={logoImage} alt="" aria-hidden="true" />
            <div className="login-brand-content">
              <img className="login-brand-image" src={logoImage} alt="硅基员工平台标志" />
              <h1>让每一位员工，<br /><span>都有一个 AI 同行者</span></h1>
              <p className="login-brand-description">连接知识、工具与行动<br />让想法走向交付，让协作自然发生。</p>
            </div>
            <p className="login-brand-values">
                <span>AI 驱动</span><i aria-hidden="true">·</i>
                <span>智能协作</span><i aria-hidden="true">·</i>
                <span>安全可信</span>
            </p>
          </section>

          <section className="login-form-panel">
            <div className="login-form-shell">
              <header className="login-card-header">
                <p className="login-form-eyebrow">欢迎回来</p>
                <h2 className="login-title">登录硅基员工平台</h2>
                <p className="login-subtitle">进入你的数字员工工作台</p>
              </header>

              <form noValidate onSubmit={handleSubmit} className="login-form">
            <div ref={accountPickerRef} className="login-field">
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
            </div>

            <button
              ref={submitButtonRef}
              type="submit"
              disabled={loading || revealing || deletingEmail !== null}
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
        </div>
      </div>
    </main>
  );
};
