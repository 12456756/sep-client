import { Store } from 'lucide-react';
import { useRef, useState } from 'react';
import { useFeedback } from '../feedback/FeedbackProvider';
import { IconHint } from './IconHint';

export function MarketplaceButton({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  const feedback = useFeedback();
  const pending = useRef(false);
  const [opening, setOpening] = useState(false);

  const open = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setOpening(true);
    const revision = feedback.getRevision();
    try {
      const result = await window.electronAPI.openMarketplace();
      if (!result.success) throw new Error('Marketplace could not be opened');
    } catch {
      if (revision === feedback.getRevision()) feedback.show({ tone: 'error', message: '无法打开员工市场，请重试' });
    } finally {
      pending.current = false;
      setOpening(false);
    }
  };

  return <IconHint label="员工市场 · 在浏览器中打开">
    <button type="button" className="ent-nav-item ent-icon-nav-item ent-marketplace-button" aria-label="员工市场" aria-busy={opening || undefined} disabled={opening} onClick={() => { void open(); }}>
      <Store size={20} strokeWidth={1.8} aria-hidden />
      {!collapsed ? <span className="ent-icon-label">员工市场</span> : null}
    </button>
  </IconHint>;
}
