import { ArrowRight, FolderOpen, Settings2 } from 'lucide-react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  workDir: string;
  onChooseFolder: () => Promise<string | null>;
  onOpenSettings: () => void;
  submitLabel: string;
  submitDisabled: boolean;
  onSubmit: () => void;
}

export function GoalComposer({ value, onChange, placeholder, workDir, onChooseFolder, onOpenSettings, submitLabel, submitDisabled, onSubmit }: Props) {
  return <div className="ent-goal">
    <textarea className="ent-goal-input" value={value} placeholder={placeholder} aria-label="工作目标"
      onChange={event => onChange(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !submitDisabled) onSubmit();
      }} />
    <div className="ent-goal-bar">
      <button type="button" className="ent-goal-tool" title={workDir || '选择本次工作的目录'} onClick={() => void onChooseFolder()}><FolderOpen size={14} aria-hidden />工作目录{workDir ? <span className="ent-goal-directory">{workDir.split(/[\\/]/).filter(Boolean).at(-1)}</span> : null}</button>
      <button type="button" className="ent-goal-tool" onClick={onOpenSettings}><Settings2 size={14} aria-hidden />运行设置</button>
      <span className="ent-goal-gap" />
      <button type="button" className="ent-arr-primary" onClick={onSubmit} disabled={submitDisabled}>{submitLabel}<ArrowRight size={15} aria-hidden /></button>
    </div>
  </div>;
}
