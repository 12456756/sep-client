import * as Dialog from '@radix-ui/react-dialog';
import { Github, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { gitHubCredentialsSchema, type GitHubCredentials } from '../../shared/connectors';
import '../feedback/feedback.css';
import '../../styles/connectors.css';

export function GitHubConnectDialog({ busy, error, onConnect, onClose, restoreFocus }: {
  busy: boolean; error?: string;
  onConnect(credentials: GitHubCredentials): Promise<boolean>; onClose(): void; restoreFocus(): void;
}): React.JSX.Element {
  const [token, setToken] = useState('');
  const [writeEnabled, setWriteEnabled] = useState(false);
  const [validation, setValidation] = useState<string>();
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const parsed = gitHubCredentialsSchema.safeParse({ token, readOnly: !writeEnabled });
    if (!parsed.success) { setValidation('请输入以 github_pat_ 或 ghp_ 开头的个人访问令牌。'); return; }
    setValidation(undefined);
    if (await onConnect(parsed.data)) { setToken(''); onClose(); }
  };
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) { setToken(''); onClose(); } }}>
    <Dialog.Portal>
      <Dialog.Overlay className="feedback-overlay" />
      <Dialog.Content asChild onInteractOutside={event => event.preventDefault()} onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
        <form className="feedback-dialog" aria-busy={busy} onSubmit={event => { void submit(event); }}>
          <Github size={24} aria-hidden />
          <div className="feedback-copy">
            <Dialog.Title className="feedback-title">连接 GitHub</Dialog.Title>
            <Dialog.Description className="feedback-description">使用个人访问令牌连接 GitHub.com。请选择允许访问的仓库，并授予 Contents、Issues 和 Pull requests 所需权限。</Dialog.Description>
            <a className="github-token-link" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">创建个人访问令牌</a>
            <label className="feedback-field">个人访问令牌<input name="githubToken" type="password" autoComplete="off" placeholder="github_pat_..." required minLength={20} maxLength={512} spellCheck={false} autoCapitalize="none" disabled={busy} value={token} onChange={event => { setToken(event.target.value); setValidation(undefined); }} /></label>
            <label className="github-write-option"><input type="checkbox" checked={writeEnabled} disabled={busy} onChange={event => setWriteEnabled(event.target.checked)} /><span>允许创建或更新 Issue、发表评论及创建 PR</span></label>
            {validation || error ? <p className="feedback-validation" role="alert">{validation || error}</p> : null}
            {busy ? <p className="github-verifying" role="status"><LoaderCircle size={14} className="spin" aria-hidden />正在验证 GitHub 账号和仓库工具</p> : null}
          </div>
          <div className="feedback-actions">
            <Dialog.Close asChild><button type="button" disabled={busy}>取消</button></Dialog.Close>
            <button type="submit" className="feedback-primary" disabled={busy}>{busy ? '验证中' : '连接'}</button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
