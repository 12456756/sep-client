import * as Dialog from '@radix-ui/react-dialog';
import { LoaderCircle, Mail } from 'lucide-react';
import { useState } from 'react';
import { qqMailCredentialsSchema, type QQMailCredentials } from '../../shared/connectors';
import '../feedback/feedback.css';

export function QQMailConnectDialog({ busy, error, account, onConnect, onClose, restoreFocus }: {
  busy: boolean; error?: string; account?: string;
  onConnect(credentials: QQMailCredentials): Promise<boolean>; onClose(): void; restoreFocus(): void;
}): React.JSX.Element {
  const [email, setEmail] = useState(account ?? '');
  const [code, setCode] = useState('');
  const [validation, setValidation] = useState<string>();
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const parsed = qqMailCredentialsSchema.safeParse({ email, authorizationCode: code });
    if (!parsed.success) { setValidation('请输入 QQ 或 Foxmail 邮箱地址和 16 位字母授权码。'); return; }
    setValidation(undefined);
    if (await onConnect(parsed.data)) { setCode(''); onClose(); }
  };
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) { setCode(''); onClose(); } }}>
    <Dialog.Portal>
      <Dialog.Overlay className="feedback-overlay" />
      <Dialog.Content asChild onInteractOutside={event => event.preventDefault()} onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
        <form className="feedback-dialog qqmail-dialog" aria-busy={busy} onSubmit={event => { void submit(event); }}>
          <Mail size={24} className="qqmail-dialog-icon" aria-hidden />
          <div className="feedback-copy">
            <Dialog.Title className="feedback-title">连接 QQ 邮箱</Dialog.Title>
            <Dialog.Description className="feedback-description">在 QQ 邮箱设置中开启 IMAP/SMTP 服务，使用生成的授权码连接。</Dialog.Description>
            <label className="feedback-field">邮箱地址<input name="email" type="email" autoComplete="username" placeholder="name@qq.com" required maxLength={254} disabled={busy} value={email} onChange={event => { setEmail(event.target.value); setValidation(undefined); }} /></label>
            <label className="feedback-field">授权码<input name="authorizationCode" type="password" autoComplete="off" placeholder="16 位字母授权码" required minLength={16} maxLength={16} spellCheck={false} disabled={busy} value={code} onChange={event => { setCode(event.target.value); setValidation(undefined); }} /></label>
            {validation || error ? <p className="feedback-validation" role="alert">{validation || error}</p> : null}
            {busy ? <p className="qqmail-verifying" role="status"><LoaderCircle size={14} className="spin" aria-hidden />正在验证收件和发件服务</p> : null}
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
