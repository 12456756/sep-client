import { FolderOpen, Users, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SiliconEmployee } from '../../../features/enterprise/types'
import { authorizedScheduledModels, automaticPlanningSelection, type ScheduledTaskDraft } from '../../../features/enterprise/scheduled-task-home'
import { RunSettingsBar, RunSettingsDirectory } from '../arrange/RunSettingsDrawer'
import { useModelPreference } from '../../workspace/model-preference-scope'
import { resolveTaskModel } from '../../../shared/model-preferences'

interface Props {
  value: ScheduledTaskDraft
  employees: SiliconEmployee[]
  onChange(patch: Partial<Pick<ScheduledTaskDraft, 'mode' | 'subscriptionId'>> & { settings?: Partial<ScheduledTaskDraft['settings']> }): void
  onChooseFolder(path?: string): Promise<string | null>
  leadingAction?: ReactNode
  action?: ReactNode
  naturalLanguage?: boolean
  allowLegacyEmptyText?: boolean
}

export function ScheduledExecutionFields({ value, employees, onChange, onChooseFolder, leadingAction, action, naturalLanguage = false, allowLegacyEmptyText = false }: Props) {
  const { defaultModelId } = useModelPreference()
  const available = employees.filter(item => item.assignedToMe && !['unavailable', 'needs-auth'].includes(item.availability))
  const employee = available.find(item => item.id === value.subscriptionId)
  const automatic = value.mode === 'auto'
  const general = value.mode === 'general'
  const local = value.mode === 'empty-text'
  const models = naturalLanguage || automatic || general ? authorizedScheduledModels(employees) : employee?.allowedModels ?? []
  const onSettings = (patch: Partial<ScheduledTaskDraft['settings']>) => {
    if (!naturalLanguage && automatic && patch.modelId !== undefined) {
      const selection = automaticPlanningSelection(available, patch.modelId, value.subscriptionId)
      onChange({ subscriptionId: selection.subscriptionId, settings: { ...patch, modelId: selection.modelId } })
    } else onChange({ settings: patch })
  }
  const environment = <div className="ent-sch-composer-environment">{local
    ? <button type="button" className="ent-rs-directory" title={value.settings.workDir || '选择成果目录'} onClick={() => void onChooseFolder(value.settings.workDir).then(path => { if (path) onSettings({ workDir: path }) })}><FolderOpen size={16} aria-hidden /><span>{value.settings.workDir || '选择成果目录'}</span></button>
    : <RunSettingsDirectory settings={value.settings} onChange={onSettings} allowedPresets={['workspace-edit', 'full-local']} inheritDefaultDirectory onChooseFolder={onChooseFolder} />}</div>
  const execution = <div className="ent-sch-execution-selects">
        {!naturalLanguage ? <label className="ent-rs-compact ent-sch-mode" title="执行方式">{automatic ? <Users size={16} /> : <UserRound size={16} />}<select aria-label="任务模式" value={value.mode} onChange={event => {
          const mode = event.target.value as ScheduledTaskDraft['mode']
          if (mode === 'auto') {
            const selection = automaticPlanningSelection(available, value.settings.modelId, value.subscriptionId, defaultModelId)
            onChange({ mode, subscriptionId: selection.subscriptionId, settings: { modelId: selection.modelId } })
          } else if (mode === 'general') {
            onChange({ mode, subscriptionId: '', settings: { modelId: resolveTaskModel(authorizedScheduledModels(employees), defaultModelId, value.settings.modelId) } })
          } else onChange({ mode })
        }}><option value="employee">指定员工</option><option value="auto">自动编排</option><option value="general">通用助手</option>{allowLegacyEmptyText && <option value="empty-text">创建空白文本</option>}</select></label> : null}
        {!naturalLanguage && !automatic && !general && !local ? <label className="ent-rs-compact ent-sch-employee"><select aria-label="执行员工" value={value.subscriptionId} onChange={event => {
          const selected = available.find(item => item.id === event.target.value)
          onChange({ subscriptionId: event.target.value, settings: { modelId: resolveTaskModel(selected?.allowedModels ?? [], defaultModelId) } })
        }}><option value="">选择员工</option>{value.subscriptionId && !available.some(item => item.id === value.subscriptionId) ? <option value={value.subscriptionId}>原员工暂不可用</option> : null}{available.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
        {!local && <RunSettingsBar settings={value.settings} models={models} onChange={onSettings} portalWithinControl={!naturalLanguage} />}
      </div>
  return <>
    <div className={`ent-sch-composer-tools${naturalLanguage ? ' ent-sch-composer-tools-inline' : ''}`}>
      {leadingAction}
      {naturalLanguage ? <div className="ent-sch-composer-settings">{execution}{environment}</div> : execution}
      {action}
    </div>
    {!naturalLanguage ? environment : null}
  </>
}
