import { ArrowRight } from 'lucide-react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  submitLabel: string;
  submitDisabled: boolean;
  onSubmit: () => void;
}

/** 工作目标输入。 */
export function GoalComposer({ value, onChange, placeholder, submitLabel, submitDisabled, onSubmit }: Props) {
  return (
    <div className="ent-goal">
      <textarea
        className="ent-goal-input"
        value={value}
        placeholder={placeholder}
        aria-label="工作目标"
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !submitDisabled) onSubmit();
        }}
      />

      <div className="ent-goal-bar">
        <span className="ent-goal-hint">支持自然语言描述目标，按 Ctrl/⌘ + Enter 开始</span>
        <span className="ent-goal-gap" />
        <button type="button" className="ent-arr-primary" onClick={onSubmit} disabled={submitDisabled}>
          {submitLabel}
          <ArrowRight size={15} aria-hidden />
        </button>
      </div>
    </div>
  );
}


