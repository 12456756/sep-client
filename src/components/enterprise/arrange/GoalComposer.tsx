import { ArrowUp } from 'lucide-react';
import type { RunSettings } from '../../../features/enterprise/run-settings';
import { RunSettingsBar, RunSettingsDirectory } from './RunSettingsDrawer';
import { useSpeechInput } from '../../../features/speech/use-speech-input';
import { SpeechInputActions, SpeechInputFeedback } from '../../speech/SpeechInputActions';

interface Props {
  busy?: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  submitLabel: string;
  submitDisabled: boolean;
  onSubmit: () => void;
  settings: RunSettings;
  models: string[];
  onSettingsChange: (patch: Partial<RunSettings>) => void;
  onChooseFolder: (currentPath?: string) => Promise<string | null>;
  conversation?: boolean;
}

export function GoalComposer({
  busy = false,
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
  const speech = useSpeechInput({ contextKey: 'auto-goal', value, onChange, disabled: busy });
  return (
    <div className="ent-goal-stack">
      <RunSettingsDirectory settings={settings} onChange={onSettingsChange} onChooseFolder={onChooseFolder} />
      <div className="ent-goal">
        <textarea
          {...speech.inputProps}
          className="ent-goal-input"
          value={value}
          placeholder={placeholder}
          aria-label="工作目标"
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => {
            speech.inputProps.onKeyDown(event);
            if (event.defaultPrevented || event.nativeEvent.isComposing || speech.busy) return;
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
          <SpeechInputActions speech={speech} disabled={busy} />
          <button
            type="button"
            className="ent-goal-send"
            aria-label={submitLabel}
            title={submitLabel}
            onClick={() => { if (!speech.busy) onSubmit(); }}
            disabled={submitDisabled || speech.busy}
          >
            <ArrowUp size={17} aria-hidden />
          </button>
        </div>
        <SpeechInputFeedback speech={speech} />
      </div>
    </div>
  );
}
