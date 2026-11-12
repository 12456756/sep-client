import { ChevronDown } from 'lucide-react';
import { useMemo } from 'react';
import { buildSkillRewriteDiff } from '../../../features/enterprise/skill-rewrite-diff';

interface Props {
  before: string;
  after: string;
  initiallyOpen?: boolean;
}

export function SkillRewriteComparison({ before, after, initiallyOpen = false }: Props): React.JSX.Element {
  const parts = useMemo(() => buildSkillRewriteDiff(before, after), [before, after]);
  return <details className="skill-chat-diff" open={initiallyOpen || undefined}>
    <summary><ChevronDown size={14} aria-hidden />查看详细差异</summary>
    <div className="skill-rewrite-comparison">
      <div className="skill-rewrite-before">
        <h3>修改前{parts.before.some(part => part.changed) ? <span className="skill-diff-removed-label">删除内容</span> : null}</h3>
        <pre tabIndex={0} aria-label="修改前内容">{parts.before.map((part, index) => part.changed ? <del key={index}>{part.text}</del> : part.text)}</pre>
      </div>
      <div className="skill-rewrite-after">
        <h3>修改后{parts.after.some(part => part.changed) ? <span>新增内容</span> : null}</h3>
        <pre tabIndex={0} aria-label="修改后内容">{parts.after.map((part, index) => part.changed ? <ins key={index}>{part.text}</ins> : part.text)}</pre>
      </div>
    </div>
  </details>;
}
