import { ArrowUp, Workflow } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { isSubmitEnter } from '../../../shared/composer-shortcut';
import type { RunSettings } from '../../../features/enterprise/run-settings';
import { RunSettingsBar, RunSettingsDirectory } from './RunSettingsDrawer';
import { PromptExamples } from './PromptExamples';
import { useSpeechInput } from '../../../features/speech/use-speech-input';
import { SpeechInputActions } from '../../speech/SpeechInputActions';
import { AttachmentComposer, type AttachmentComposerOperations } from '../attachments/AttachmentComposer';
import { FileMentionChips, FileMentionPicker, useFileMention } from '../attachments/FileMentionPicker';
import { FileMentionEditor } from '../attachments/FileMentionEditor';
import type { AttachmentImportSession, AttachmentView } from '../../../shared/attachment-contracts';
import { KnowledgeSelector } from '../KnowledgeSelector';
import type { ConnectorId } from '../../../shared/connectors';
import { withComposerConnector } from '../../../features/enterprise/composer-connectors';

interface Props {
  busy?: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  submitLabel: string;
  submitDisabled: boolean;
  onSubmit: (text?: string, submittedAttachments?: AttachmentView[]) => void;
  onAttachmentsChange?: (attachments: AttachmentView[]) => void;
  onAttachmentSessionChange?: (session: AttachmentImportSession | null) => void;
  onAttachmentsBusyChange?: (busy: boolean) => void;
  settings: RunSettings;
  models: string[];
  onSettingsChange: (patch: Partial<RunSettings>) => void;
  onChooseFolder: (currentPath?: string) => Promise<string | null>;
  conversation?: boolean;
  attachmentBindingKey?: string;
  showExamples?: boolean;
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
  showExamples = false,
}: Props) {
  const [attachments, setAttachments] = useState<AttachmentView[]>([]);
  const [attachmentSessionId, setAttachmentSessionId] = useState<string>();
  const handleAttachmentSession = useCallback((session: AttachmentImportSession | null) => {
    setAttachmentSessionId(session?.sessionId);
    onAttachmentSessionChange?.(session);
  }, [onAttachmentSessionChange]);
  const attachmentOps = useRef<AttachmentComposerOperations>(null);
  const [connectorId, setConnectorId] = useState<ConnectorId>();
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const [attachmentListContainer, setAttachmentListContainer] = useState<HTMLDivElement | null>(null);
  const composerId = useRef(`goal-${crypto.randomUUID()}`);
  const [editorVersion, setEditorVersion] = useState(0);
  const speech = useSpeechInput({ contextKey: 'auto-goal', value, onChange, disabled: busy });
  const mention = useFileMention({ input: speech.inputProps.ref, text: value, update: next => { onChange(next); setEditorVersion(version => version + 1); }, attachments, attachmentSessionId, operations: attachmentOps, disabled: busy || speech.busy || attachmentsBusy });
  const blocked = submitDisabled || busy || speech.busy || attachmentsBusy || mention.pending || mention.invalid;
  const submit = () => { if (!blocked) onSubmit(withComposerConnector(mention.submissionText, connectorId), mention.attachments); };
  const onPasteEdit = useCallback(({ text: pasted, selectionStart, selectionEnd, editorVersion: pastedVersion }: { text: string; selectionStart: number; selectionEnd: number; editorVersion: number }) => {
    if (pastedVersion !== editorVersion) return false;
    onChange(`${value.slice(0, selectionStart)}${pasted}${value.slice(selectionEnd)}`);
    setEditorVersion(version => version + 1);
    return true;
  }, [editorVersion, onChange, value]);
  return (
    <>
      {showExamples && !value && !busy ? <div className="ent-arr-empty-state">
        <span className="ent-arr-empty-icon" aria-hidden="true"><Workflow size={24} strokeWidth={1.8} /></span>
        <p>描述一个目标，开始编排</p>
        <PromptExamples mode="arrangement" disabled={speech.busy} inputRef={speech.inputProps.ref} onSelect={prompt => { onChange(prompt); setEditorVersion(version => version + 1); }} />
      </div> : null}
      <div className="ent-goal-stack">
        <RunSettingsDirectory settings={settings} onChange={onSettingsChange} onChooseFolder={onChooseFolder} />
        <div className="ent-goal">
          <div className="ent-composer-attachments" ref={setAttachmentListContainer} />
          <FileMentionEditor mention={mention}
            data-composer-id={composerId.current}
            data-editor-version={editorVersion}
            {...speech.inputProps}
            className="ent-goal-input"
            value={value}
            placeholder={placeholder}
            aria-label="工作目标"
            {...mention.editorAria}
            onChange={event => mention.change(event.currentTarget, (event.nativeEvent as InputEvent).inputType)}
            onCompositionStart={() => { speech.inputProps.onCompositionStart(); mention.compositionStart(); }}
            onCompositionEnd={event => { speech.inputProps.onCompositionEnd(); mention.compositionEnd(event.currentTarget); }}
            onKeyDown={event => {
              mention.keyDown(event);
              speech.inputProps.onKeyDown(event);
              if (isSubmitEnter(event, speech.isComposing())) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <FileMentionChips mention={mention} />
          <div className="ent-goal-bar">
            <AttachmentComposer operationsRef={attachmentOps} visibleAttachments={mention.unreferencedAttachments} connectorId={connectorId} onConnectorChange={setConnectorId} listContainer={attachmentListContainer} target={{ kind: 'compose', composerId: composerId.current }} bindingKey={attachmentBindingKey} disabled={busy || speech.busy} onChange={items => { setAttachments(items); onAttachmentsChange?.(items); }} onSessionChange={handleAttachmentSession} onBusyChange={value => { setAttachmentsBusy(value); onAttachmentsBusyChange?.(value); }} onPasteEdit={onPasteEdit} />
            <FileMentionPicker mention={mention} />
            <KnowledgeSelector value={settings.knowledge} onChange={knowledge => onSettingsChange({ knowledge })} disabled={busy} scopeKey={attachmentBindingKey} />
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
              onClick={submit}
              disabled={blocked}
            >
              <ArrowUp size={17} aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
