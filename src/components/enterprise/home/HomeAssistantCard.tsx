import * as Dialog from '@radix-ui/react-dialog'
import { Bot, Check, ChevronRight, FileText, LoaderCircle, Paperclip, Search, Send, Settings, X } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, type RefObject } from 'react'
import assistantImage from '../../../assets/home/assistant.svg'
import type { HomeDraft } from '../../../features/enterprise/home-draft'
import { GENERAL_ASSISTANT_ID, generalAssistant } from '../../../features/enterprise/general-assistant'
import { useAttachmentComposer } from '../../../features/enterprise/use-attachment-composer'
import type { ConversationOptions } from '../../../features/enterprise/useEnterpriseWorkspace'
import type { SiliconEmployee } from '../../../features/enterprise/types'
import type { AttachmentView } from '../../../shared/attachment-contracts'
import { isSubmitEnter } from '../../../shared/composer-shortcut'
import { EmployeeFace } from '../EmployeeFace'
import { useSpeechInput } from '../../../features/speech/use-speech-input'
import { SpeechInputActions } from '../../speech/SpeechInputActions'

interface Props {
  employees: SiliconEmployee[]
  draft: HomeDraft
  onSubmit: (employeeId: string, text: string, options?: ConversationOptions) => Promise<boolean>
  onCreate: () => void
  demo: boolean
  busy: boolean
}
interface Editor {
  text: string
  update: (text: string) => void
  version: RefObject<number>
}
interface Attachments {
  attachments: AttachmentView[]
  busy: boolean
  error: string | null
  select: () => void
  remove: (id: string) => void
}

export function HomeAssistantCard(props: Props) {
  const [text, setText] = useState(props.draft.text)
  const version = useRef(0)
  const update = useCallback((value: string) => {
    props.draft.text = value
    version.current++
    setText(value)
  }, [props.draft])
  const editor = { text, update, version }
  return props.demo ? <AssistantForm {...props} editor={editor} /> : <LiveAssistant {...props} editor={editor} />
}

function LiveAssistant(props: Props & { editor: Editor }) {
  const { draft, editor: { update, version } } = props
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const target = useMemo(() => ({ kind: 'compose' as const, composerId: props.draft.composerId }), [props.draft.composerId])
  const onPasteEdit = useCallback((input: { text: string; selectionStart: number; selectionEnd: number; editorVersion: number }) => {
    if (input.editorVersion !== version.current) return false
    const text = draft.text
    update(`${text.slice(0, input.selectionStart)}${input.text}${text.slice(input.selectionEnd)}`)
    return true
  }, [draft, update, version])
  const composer = useAttachmentComposer({ target, bindingKey: `${props.draft.composerId}:${props.draft.epoch}`, disabled: props.busy,
    retainedState: props.draft.attachment, onPasteEdit, onError: setAttachmentError })
  return <AssistantForm {...props} attachment={{ attachments: composer.attachments, busy: composer.busy, error: attachmentError,
    select: () => { setAttachmentError(null); void composer.select() }, remove: id => { setAttachmentError(null); void composer.remove(id) } }} />
}

function AssistantForm({ employees, draft, onSubmit, onCreate, demo, busy, editor, attachment }: Props & { editor: Editor; attachment?: Attachments }) {
  const [employeeId, setEmployeeId] = useState(draft.employeeId)
  const [panel, setPanel] = useState<'employee' | 'demo' | 'file' | null>(null)
  const [query, setQuery] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const speech = useSpeechInput({ contextKey: `home:${draft.composerId}:${employeeId}`, value: editor.text, onChange: editor.update, disabled: demo || busy || submitting || Boolean(attachment?.busy) })
  const input = speech.inputProps.ref
  const submitLock = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const assistant = useMemo(() => generalAssistant(employees.filter(employee => employee.availability !== 'unavailable')), [employees])
  const employee = employeeId === GENERAL_ASSISTANT_ID ? assistant : employees.find(item => item.id === employeeId)
  const pickerEmployees = [assistant, ...employees].filter(item => !query.trim() || `${item.name} ${item.roleName}`.includes(query.trim()))
  const blocked = busy || submitting || Boolean(attachment?.busy) || speech.busy
  const selectionProblem = !employee ? '所选员工已不在当前授权列表，请重新选择。'
    : !demo && (employee.availability === 'unavailable' || employee.availability === 'needs-auth' || !employee.allowedModels.length) ? '该员工当前不可用，请检查授权或选择其他员工。' : null
  const selectEmployee = (id: string) => { draft.employeeId = id; setEmployeeId(id); setPanel(null); setError(null); input.current?.focus() }
  const submit = async () => {
    if (blocked || submitLock.current || !editor.text.trim()) return
    if (demo) { setPanel('demo'); return }
    if (selectionProblem) { setError(selectionProblem); return }
    submitLock.current = true
    setSubmitting(true)
    setError(null)
    try {
      const success = await onSubmit(employeeId, editor.text.trim(), {
        attachmentSessionId: draft.attachment.session?.sessionId,
        attachmentRefs: attachment?.attachments.map(item => ({ attachmentId: item.attachmentId, sha256: item.sha256 })),
      })
      if (success) {
        editor.update('')
        draft.attachment.session = null
        draft.attachment.attachments = []
        draft.epoch++
      } else setError('需求尚未发送成功，请查看错误提示后重试，输入内容已保留。')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '需求发送失败，请重试。') }
    finally { submitLock.current = false; setSubmitting(false) }
  }

  return <section className="sep-home-assistant" aria-label="AI 助手">
    <div className="sep-home-assistant-heading"><img src={assistantImage} width={64} height={64} alt="" /><div><h2>AI 助手</h2><p>我可以帮您完成任务、分析数据、创建内容或调用企业员工</p></div><button type="button" aria-label="打开任务中心" onClick={onCreate}><ChevronRight size={19} aria-hidden /></button></div>
    <div className="sep-home-composer" data-composer-id={draft.composerId} data-editor-version={editor.version.current}>
      <textarea {...speech.inputProps} aria-label="工作需求" placeholder="请输入您的需求，例如：帮我分析本月销售数据，生成可视化报表" value={editor.text} onChange={event => editor.update(event.target.value)} disabled={busy || submitting} rows={2}
        onKeyDown={event => { speech.inputProps.onKeyDown(event); if (isSubmitEnter(event, speech.isComposing())) { event.preventDefault(); void submit() } }} />
      {employeeId !== GENERAL_ASSISTANT_ID ? <div className="sep-home-draft-chips">
        <button type="button" disabled={blocked} title={employee?.name} onClick={() => selectEmployee(GENERAL_ASSISTANT_ID)}><Bot size={12} aria-hidden />{employee?.name ?? '请重新选择员工'}<X size={11} aria-hidden /></button>
      </div> : null}
      {attachment?.attachments.length ? <div className="sep-home-attachments" aria-label="已添加附件">{attachment.attachments.map(item => <div key={item.attachmentId}><FileText size={15} aria-hidden /><span title={item.displayName}>{item.displayName}<small>{item.extractionStatus === 'failed' ? '解析失败' : item.extractionStatus === 'pending' ? '正在处理' : '已添加'}</small></span><button type="button" disabled={blocked} onClick={() => attachment.remove(item.attachmentId)} aria-label={`移除 ${item.displayName}`}><X size={13} aria-hidden /></button></div>)}</div> : null}
      <div className="sep-home-composer-toolbar"><div className="sep-home-composer-actions">
        <button type="button" className="sep-home-paperclip" aria-label="添加附件" title="上传文件" disabled={blocked} onClick={() => demo ? setPanel('file') : attachment?.select()}><Paperclip size={20} aria-hidden /></button>
        <button type="button" disabled={blocked} onClick={() => { setQuery(''); setPanel('employee') }}><Settings size={15} aria-hidden /><span>选择员工</span></button>
      </div><div className="sep-home-composer-send"><SpeechInputActions speech={speech} disabled={demo || busy || submitting || Boolean(attachment?.busy)} /><button type="button" className="sep-home-send" aria-label="发送需求" disabled={blocked || !editor.text.trim()} onClick={() => { void submit() }}>{submitting || attachment?.busy ? <LoaderCircle size={19} aria-hidden /> : <Send size={19} aria-hidden />}</button></div></div>
    </div>
    {error || attachment?.error ? <p role="alert" className="sep-home-composer-error">{error ?? attachment?.error}</p> : null}
    <Dialog.Root open={panel !== null} onOpenChange={open => { if (!open) setPanel(null) }}><Dialog.Portal><Dialog.Overlay className="sep-home-dialog-overlay" />
      <Dialog.Content className="sep-home-dialog" aria-describedby="home-assistant-dialog-description" onCloseAutoFocus={event => { event.preventDefault(); input.current?.focus() }}>
        <Dialog.Title>{panel === 'employee' ? '选择员工' : panel === 'file' ? '上传文件' : '演示模式'}</Dialog.Title>
        <Dialog.Description id="home-assistant-dialog-description">{panel === 'employee' ? '选择一位员工协助完成本次工作。' : '当前为首页演示模式，不会创建真实任务或导入本地文件。'}</Dialog.Description>
        {panel === 'employee' ? <><label className="sep-home-picker-search"><Search size={17} aria-hidden /><input aria-label="搜索员工" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称或职能" /></label><div className="sep-home-picker-list">{pickerEmployees.length ? pickerEmployees.map(item => <button type="button" key={item.id} onClick={() => selectEmployee(item.id)} disabled={!demo && (item.availability === 'unavailable' || item.availability === 'needs-auth')}><EmployeeFace employee={item} name={item.name} round /><span><strong>{item.name}</strong><small>{item.roleName}{item.availability === 'unavailable' ? ' · 暂不可用' : item.availability === 'needs-auth' ? ' · 需授权' : ''}</small></span>{employeeId === item.id ? <Check size={18} aria-hidden /> : null}</button>) : <p>没有找到匹配的员工</p>}</div></> : null}
        <Dialog.Close className="sep-home-dialog-done">{panel === 'employee' ? '取消' : '知道了'}</Dialog.Close>
      </Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>
}
