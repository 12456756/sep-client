import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ChevronRight, LoaderCircle, Sparkles, X } from 'lucide-react'
import { cronPreview } from '../../../shared/cron-schedule'
import type { ScheduledTasksModel } from '../../../features/enterprise/use-scheduled-tasks'
import { WEEKDAYS, timingConfiguration, type RepeatKind, type ScheduleTiming } from '../../../features/enterprise/scheduled-time-form'
import { scheduleTime } from '../../../features/enterprise/scheduled-task-model'

interface Props {
  value: ScheduleTiming
  onChange(value: ScheduleTiming): void
  model: Pick<ScheduledTasksModel, 'interpretTime'>
  employeeId: string
  modelId: string
  onParsingChange(value: boolean): void
}

export function ScheduledTimeSettings({ value, onChange, model, employeeId, modelId, onParsingChange }: Props) {
  const [customOpen, setCustomOpen] = useState(false)
  const [description, setDescription] = useState(value.custom?.description ?? '')
  const [parsed, setParsed] = useState<{ expression: string; description: string; timezone: string } | null>(null)
  const [parsing, setParsing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [container] = useState(() => typeof document === 'undefined' ? undefined : document.querySelector<HTMLElement>('.ent-shell') ?? undefined)
  const request = useRef(0)
  useEffect(() => () => { request.current++ }, [])
  let preview: number[] = []
  try { preview = timingConfiguration(value).preview } catch { /* Incomplete fields are validated on save. */ }
  const update = (patch: Partial<ScheduleTiming>) => onChange({ ...value, ...patch })
  const openCustom = () => { setDescription(value.custom?.description ?? ''); setParsed(value.custom?.timezone === value.timezone ? value.custom : null); setError(null); setCustomOpen(true) }
  const interpret = async () => {
    if (parsing || !description.trim()) return
    if (!employeeId || !modelId) { setError('请先选择员工和模型。'); return }
    const version = ++request.current
    setParsing(true); onParsingChange(true); setParsed(null); setError(null)
    try {
      const result = await model.interpretTime({ requestId: crypto.randomUUID(), subscriptionId: employeeId, modelId, timezone: value.timezone, description })
      if (version !== request.current) return
      if (result.status === 'blocked') setError(result.reasons.join('；'))
      else { cronPreview(result.expression, value.timezone, Date.now()); setParsed({ expression: result.expression, description: description.trim(), timezone: value.timezone }) }
    } catch { if (version === request.current) setError('时间解析未完成。请检查登录、模型授权和网络后重试，输入内容已保留。') }
    finally { if (version === request.current) { setParsing(false); onParsingChange(false) } }
  }
  const legacyInterval = value.interval > 1 && ['daily', 'weekly'].includes(value.kind)

  return <>
    <div className="ent-sch-repeat" aria-label="定时设置">
      <div className="ent-sch-time-row"><label htmlFor="schedule-repeat">重复</label><select id="schedule-repeat" aria-label="重复频率" value={value.kind} onChange={event => {
        const kind = event.target.value as RepeatKind
        if (kind === 'custom') openCustom()
        else update({ kind, interval: 1 })
      }}><option value="hourly">每小时</option><option value="daily">每天</option><option value="weekly">每周</option>{value.kind === 'monthly' ? <option value="monthly">每月</option> : null}<option value="custom">自定义</option><option value="once">不重复</option></select></div>
      {value.kind === 'hourly' ? <div className="ent-sch-time-row"><label htmlFor="schedule-minute">在第几分钟</label><span className="ent-sch-time-value"><input id="schedule-minute" aria-label="每小时的分钟" type="number" min={0} max={59} required value={Number.isNaN(value.minute) ? '' : value.minute} onChange={event => update({ minute: event.target.value === '' ? NaN : Number(event.target.value) })} />分</span></div> : null}
      {value.kind === 'weekly' && !legacyInterval ? <div className="ent-sch-time-row weekday-row"><span>频率</span><div className="ent-sch-weekdays" role="group" aria-label="每周执行日期">{WEEKDAYS.map(day => <label key={day.value}><input type="checkbox" checked={value.weekdays.includes(day.value)} onChange={event => update({ weekdays: event.target.checked ? [...value.weekdays, day.value] : value.weekdays.filter(item => item !== day.value) })} /><span>{day.label}</span></label>)}</div></div> : null}
      {value.kind === 'daily' || (value.kind === 'weekly' && !legacyInterval) ? <div className="ent-sch-time-row"><label htmlFor="schedule-clock">运行时间</label><input id="schedule-clock" type="time" aria-label="运行时间" required value={value.clock} onChange={event => update({ clock: event.target.value, onceAt: `${value.onceAt.slice(0, 10)}T${event.target.value}` })} /></div> : null}
      {value.kind === 'once' || value.kind === 'monthly' || legacyInterval ? <div className="ent-sch-time-row"><label htmlFor="schedule-once">{value.kind === 'once' ? '运行时间' : '首次运行时间'}</label><input id="schedule-once" type="datetime-local" aria-label="执行时间" required value={value.onceAt} onChange={event => update({ onceAt: event.target.value })} /></div> : null}
      {value.kind === 'monthly' || legacyInterval ? <div className="ent-sch-time-row"><label htmlFor="schedule-interval">间隔</label><input id="schedule-interval" aria-label="周期间隔" type="number" min={1} max={365} value={value.interval} onChange={event => update({ interval: Number(event.target.value) })} /></div> : null}
      {value.kind === 'custom' ? <div className="ent-sch-time-row"><span>频率</span><button type="button" className="ent-sch-custom-rule" onClick={openCustom}><span>{value.custom?.description ?? '请选择'}</span><ChevronRight size={16} /></button></div> : null}
      <div className="ent-sch-time-row timezone-row"><label htmlFor="schedule-timezone">时区</label><input id="schedule-timezone" aria-label="执行时区" list="scheduled-timezones" required value={value.timezone} onChange={event => update({ timezone: event.target.value })} /><datalist id="scheduled-timezones">{['Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo', 'UTC', 'Europe/London', 'America/New_York', 'America/Los_Angeles'].map(zone => <option key={zone} value={zone} />)}</datalist></div>
    </div>
    {preview.length ? <div className="ent-sch-preview" aria-label="预计执行时间"><span>下次运行</span><time>{scheduleTime(preview[0]!, value.timezone)}</time></div> : null}
    <Dialog.Root open={customOpen} onOpenChange={open => { if (!parsing) setCustomOpen(open) }}>
      <Dialog.Portal container={container}><Dialog.Overlay className="ent-sch-modal-overlay nested" /><Dialog.Content className="ent-sch-custom-modal" onPointerDownOutside={event => event.preventDefault()}>
        <header><Dialog.Title>自定义时间</Dialog.Title><Dialog.Close asChild><button type="button" className="ent-sch-close" aria-label="关闭自定义时间" title="关闭" disabled={parsing}><X size={18} /></button></Dialog.Close></header>
        <Dialog.Description className="sr-only">定时任务的运行频率</Dialog.Description>
        <textarea aria-label="自定义时间描述" value={description} maxLength={2000} disabled={parsing} onChange={event => { setDescription(event.target.value); setParsed(null); setError(null) }} placeholder="用自然语言描述运行时间，例如：每个月的第 1、15、30 号早上 9 点半" />
        {error ? <p role="alert" className="ent-sch-modal-error">{error}</p> : null}
        {parsed ? <div className="ent-sch-parsed" role="status"><strong>预计运行时间 · {value.timezone}</strong><ol>{cronPreview(parsed.expression, value.timezone, Date.now()).map(time => <li key={time}>{scheduleTime(time, value.timezone)}</li>)}</ol><code>{parsed.expression}</code></div> : null}
        <footer><Dialog.Close asChild><button type="button" className="ent-btn" disabled={parsing}>取消</button></Dialog.Close>{parsed ? <button type="button" className="ent-btn primary" onClick={() => { update({ kind: 'custom', interval: 1, custom: parsed }); setCustomOpen(false) }}>确认时间</button> : <button type="button" className="ent-btn primary" disabled={parsing || !description.trim()} onClick={() => void interpret()}>{parsing ? <LoaderCircle size={15} className="ent-sch-spin" /> : <Sparkles size={15} />}{parsing ? '正在解析' : '解析时间'}</button>}</footer>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </>
}
