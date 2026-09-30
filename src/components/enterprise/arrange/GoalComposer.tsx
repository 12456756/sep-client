import { ArrowUp } from 'lucide-react';
import type { RunSettings } from '../../../features/enterprise/run-settings';
import { RunSettingsBar, RunSettingsDirectory } from './RunSettingsDrawer';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  submitLabel: string;
  submitDisabled: boolean;
  onSubmit: () => void;
  settings: RunSettings;
  models: string[];
  onSettingsChange: (patch: Partial<RunSettings>) => void;
  onChooseFolder: () => Promise<string | null>;
  conversation?: boolean;
}

export function GoalComposer({
  value,
  onChange,
  placeholder,
  submitLabel,
  submitDisabled,
  onSubmit,
  settings,
  models,
  onSettingsChange,
  onChooseFolder,
  conversation = false,
}: Props) {
  return (
    <div className="ent-goal-stack">
      <RunSettingsDirectory settings={settings} onChange={onSettingsChange} onChooseFolder={onChooseFolder} />
      <div className="ent-goal">
        <textarea
          className="ent-goal-input"
          value={value}
          placeholder={placeholder}
          aria-label="工作目标"
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !submitDisabled) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <div className="ent-goal-bar">
          <RunSettingsBar
            settings={settings}
            models={models}
            conversation={conversation}
            onChange={onSettingsChange}
          />
          <span className="ent-arr-gap" aria-hidden="true" />
          <button
            type="button"
            className="ent-goal-send"
            aria-label={submitLabel}
            title={submitLabel}
            onClick={onSubmit}
            disabled={submitDisabled}
          >
            <ArrowUp size={17} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
