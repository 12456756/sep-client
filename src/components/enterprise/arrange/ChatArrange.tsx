/**
 * 会话模式：像传统桌面端聊天输入框一样，把员工选择和发送动作收进底部工具栏。
 * 页面主体保持安静，不用额外说明文字占据首屏。
 */

import { ArrowUp, MessageSquare } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { isSubmitEnter } from '../../../shared/composer-shortcut';
import type { SiliconEmployee } from '../../../features/enterprise/types';
import type { RunSettings } from '../../../features/enterprise/run-settings';
import { RunSettingsBar, RunSettingsDirectory } from './RunSettingsDrawer';
import { PromptExamples } from './PromptExamples';
import { ConversationEmployeePicker } from '../ConversationEmployeePicker';
import { useSpeechInput } from '../../../features/speech/use-speech-input';
import { SpeechInputActions } from '../../speech/SpeechInputActions';
import { AttachmentComposer } from '../attachments/AttachmentComposer';
import type { AttachmentImportSession, AttachmentView } from '../../../shared/attachment-contracts';
import { KnowledgeSelector } from '../KnowledgeSelector';
import type { ConnectorId } from '../../../shared/connectors';
import { withComposerConnector } from '../../../features/enterprise/composer-connectors';

interface Props {
  employees: SiliconEmployee[];
  busy: boolean;
  employeeId: string;
  onEmployeeChange: (employeeId: string) => void;
  onStart: (employeeId: string, text: string, attachments: AttachmentView[], session: AttachmentImportSession | null) => void;
  settings: RunSettings;
  models: string[];
  onSettingsChange: (patch: Partial<RunSettings>) => void;
  onChooseFolder: (currentPath?: string) => Promise<string | null>;
  attachmentBindingKey?: string;
}

export function ChatArrange({ employees, busy, employeeId, onEmployeeChange, onStart, settings, models, onSettingsChange, onChooseFolder, attachmentBindingKey }: Props) {
  const [text, setText] = useState('');
  const [connectorId, setConnectorId] = useState<ConnectorId>();
  const [submitted, setSubmitted] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentView[]>([]);
  const [attachmentSession, setAttachmentSession] = useState<AttachmentImportSession | null>(null);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const [attachmentListContainer, setAttachmentListContainer] = useState<HTMLDivElement | null>(null);
  const [editorVersion, setEditorVersion] = useState(0);
  const composerId = useRef(`chat-${crypto.randomUUID()}`);
  const speech = useSpeechInput({ contextKey: `chat:${employeeId}`, value: text, onChange: setText, disabled: busy });
  const input = speech.inputProps.ref;
  const employee = employees.find(item => item.id === employeeId);
  const ready = Boolean(employee && text.trim() && models.includes(settings.modelId)) && !attachmentsBusy;
  const onPasteEdit = useCallback(({ text: pasted, selectionStart, selectionEnd, editorVersion: pastedVersion }: { text: string; selectionStart: number; selectionEnd: number; editorVersion: number }) => {
    if (pastedVersion !== editorVersion) return false;
    setText(current => `${current.slice(0, selectionStart)}${pasted}${current.slice(selectionEnd)}`);
    setEditorVersion(version => version + 1);
    return true;
  }, [editorVersion]);
  const start = () => {
    if (ready && !busy && !speech.busy) {
      setSubmitted(true);
      onStart(employeeId, withComposerConnector(text, connectorId), attachments, attachmentSession);
    }
  };

  return (
    <section className="ent-arr-chat">
      {!submitted && !text && !busy ? (
        <div className="ent-arr-empty-state">
          <span className="ent-arr-empty-icon" aria-hidden="true"><MessageSquare size={24} strokeWidth={1.8} /></span>
          <p>开始一段对话</p>
          <PromptExamples mode="conversation" disabled={speech.busy} inputRef={input} onSelect={prompt => { setText(prompt); setEditorVersion(version => version + 1); }} />
        </div>
      ) : null}
      <RunSettingsDirectory settings={settings} onChange={onSettingsChange} onChooseFolder={onChooseFolder} />
      <div className="ent-chat-ask">
        <div className="ent-composer-attachments" ref={setAttachmentListContainer} />
        <textarea
          data-composer-id={composerId.current}
          data-editor-version={editorVersion}
          {...speech.inputProps}
          className="ent-chat-input"
          value={text}
          placeholder="随心输入"
          aria-label="工作目标"
          onChange={event => { setText(event.target.value); setEditorVersion(version => version + 1); }}
          onKeyDown={event => {
            speech.inputProps.onKeyDown(event);
            if (isSubmitEnter(event, speech.isComposing())) {
              event.preventDefault();
              start();
            }
          }}
        />
        <div className="ent-chat-askbar">
          <AttachmentComposer connectorId={connectorId} onConnectorChange={setConnectorId} listContainer={attachmentListContainer} target={{ kind: 'compose', composerId: composerId.current }} bindingKey={`${attachmentBindingKey}:${employeeId}`} disabled={busy || speech.busy} onChange={setAttachments} onSessionChange={setAttachmentSession} onBusyChange={setAttachmentsBusy} onPasteEdit={onPasteEdit} />
          <ConversationEmployeePicker employees={employees} employeeId={employeeId} onChange={onEmployeeChange} onChoose={() => input.current?.focus()} />
          <KnowledgeSelector value={settings.knowledge} onChange={knowledge => onSettingsChange({ knowledge })} disabled={busy} scopeKey={attachmentBindingKey} />
          <RunSettingsBar
            settings={settings}
            models={models}
            conversation
            onChange={onSettingsChange}
          />
          <span className="ent-arr-gap" />
          <SpeechInputActions speech={speech} disabled={busy} />
          <button type="button" className="ent-chat-send" aria-label="开始工作" disabled={!ready || busy || speech.busy} onClick={start}>
            <ArrowUp size={17} aria-hidden />
          </button>
        </div>
      </div>
    </section>
  );
}
