import { ArrowUp } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { isSubmitEnter } from '../../../shared/composer-shortcut';
import type { RunSettings } from '../../../features/enterprise/run-settings';
import { RunSettingsBar, RunSettingsDirectory } from './RunSettingsDrawer';
import { useSpeechInput } from '../../../features/speech/use-speech-input';
import { SpeechInputActions } from '../../speech/SpeechInputActions';
import { AttachmentComposer } from '../attachments/AttachmentComposer';
import type { AttachmentImportSession, AttachmentView } from '../../../shared/attachment-contracts';

interface Props {
  busy?: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  submitLabel: string;
  submitDisabled: boolean;
  onSubmit: () => void;
  onAttachmentsChange?: (attachments: AttachmentView[]) => void;
  onAttachmentSessionChange?: (session: AttachmentImportSession | null) => void;
  onAttachmentsBusyChange?: (busy: boolean) => void;
  settings: RunSettings;
  models: string[];
  onSettingsChange: (patch: Partial<RunSettings>) => void;
  onChooseFolder: (currentPath?: string) => Promise<string | null>;
  conversation?: boolean;
  attachmentBindingKey?: string;
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
  attachmentBindingKey,
  onAttachmentsChange,
  onAttachmentSessionChange,
  onAttachmentsBusyChange,
}: Props) {
  const [, setAttachments] = useState<AttachmentView[]>([]);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const [attachmentListContainer, setAttachmentListContainer] = useState<HTMLDivElement | null>(null);
  const composerId = useRef(`goal-${crypto.randomUUID()}`);
  const [editorVersion, setEditorVersion] = useState(0);
  const speech = useSpeechInput({ contextKey: 'auto-goal', value, onChange, disabled: busy });
  const onPasteEdit = useCallback(({ text: pasted, selectionStart, selectionEnd, editorVersion: pastedVersion }: { text: string; selectionStart: number; selectionEnd: number; editorVersion: number }) => {
    if (pastedVersion !== editorVersion) return false;
    onChange(`${value.slice(0, selectionStart)}${pasted}${value.slice(selectionEnd)}`);
    setEditorVersion(version => version + 1);
    return true;
  }, [editorVersion, onChange, value]);
  return (
    <div className="ent-goal-stack">
      <RunSettingsDirectory settings={settings} onChange={onSettingsChange} onChooseFolder={onChooseFolder} />
      <div className="ent-goal">
        <div className="ent-composer-attachments" ref={setAttachmentListContainer} />
        <textarea
          data-composer-id={composerId.current}
          data-editor-version={editorVersion}
          {...speech.inputProps}
          className="ent-goal-input"
          value={value}
          placeholder={placeholder}
          aria-label="工作目标"
          onChange={event => { onChange(event.target.value); setEditorVersion(version => version + 1); }}
          onKeyDown={event => {
            speech.inputProps.onKeyDown(event);
            if (isSubmitEnter(event, speech.isComposing())) {
              event.preventDefault();
              if (!submitDisabled && !busy && !speech.busy) onSubmit();
            }
          }}
        />
        <div className="ent-goal-bar">
          <AttachmentComposer listContainer={attachmentListContainer} target={{ kind: 'compose', composerId: composerId.current }} bindingKey={attachmentBindingKey} disabled={busy} onChange={items => { setAttachments(items); onAttachmentsChange?.(items); }} onSessionChange={onAttachmentSessionChange} onBusyChange={value => { setAttachmentsBusy(value); onAttachmentsBusyChange?.(value); }} onPasteEdit={onPasteEdit} />
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
            disabled={submitDisabled || speech.busy || attachmentsBusy}
          >
            <ArrowUp size={17} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
