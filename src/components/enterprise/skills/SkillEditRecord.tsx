import { Check, Eye, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IconHint } from '../IconHint';
import type { SkillRewriteResult } from '../../../shared/skill-rewrite';
import { SkillRewriteComparison } from './SkillRewriteComparison';

interface Props {
  label: string;
  applied: boolean;
  canUndo: boolean;
  disabled: boolean;
  undoLabel: string;
  undoHint: string;
  onUndo(): void;
  before: string;
  after: string;
  summary?: string;
  changes?: SkillRewriteResult['changes'];
}

const changeLabels = { add: '新增', change: '调整', remove: '删除' };

export function SkillEditRecord({ label, applied, canUndo, disabled, undoLabel, undoHint, onUndo, before, after, summary, changes }: Props): React.JSX.Element {
  const [previewOpen, setPreviewOpen] = useState(false);
  const preview = useRef<HTMLElement>(null);
  useEffect(() => {
    if (previewOpen) preview.current?.scrollIntoView({ block: 'start' });
  }, [previewOpen]);
  return <>
    <div className={`skill-chat-round-status${applied ? ' is-accepted' : ''}`}>
      <span className="skill-chat-record-state" role="status">{applied ? <Check size={14} aria-hidden /> : null}{label}</span>
      {applied ? <IconHint label={undoHint} side="top"><span className="skill-rewrite-undo-trigger" tabIndex={!canUndo ? 0 : undefined} aria-label={!canUndo ? undoHint : undefined}>
        <button type="button" className="skill-rewrite-icon" aria-label={undoLabel} disabled={disabled || !canUndo} onClick={onUndo}><Undo2 size={14} aria-hidden /></button>
      </span></IconHint> : null}
      <button type="button" className="skill-text-button" aria-expanded={previewOpen} onClick={() => setPreviewOpen(open => !open)}><Eye size={14} aria-hidden />{previewOpen ? '收起预览' : '查看预览'}</button>
    </div>
    {previewOpen ? <section ref={preview} className="skill-rewrite-preview" aria-label="历史修改预览">
      {summary ? <p className="skill-chat-response">{summary}</p> : null}
      {changes ? <ul className="skill-chat-changes">{changes.map((change, index) => <li key={index}><span className="skill-chat-added">{changeLabels[change.kind]}</span><div><strong>{change.title}</strong><p>{change.detail}</p></div></li>)}</ul> : null}
      <SkillRewriteComparison before={before} after={after} initiallyOpen />
    </section> : null}
  </>;
}
