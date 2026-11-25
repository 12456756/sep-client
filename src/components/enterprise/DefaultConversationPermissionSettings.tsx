import { useConversationPermissionPreference } from '../../features/enterprise/conversation-permission-scope'
import { FULL_FILE_ACCESS_CONFIRMATION, RUN_PERMISSIONS } from '../../features/enterprise/run-settings'
import type { ArrangementPermissionPreset } from '../../shared/types'
import { useFeedback } from '../feedback/FeedbackProvider'
import { useOperationFeedback } from '../feedback/use-operation-feedback'

export function DefaultConversationPermissionSettings() {
  const { preset, error, save } = useConversationPermissionPreference()
  const feedback = useFeedback()
  const { capture } = useOperationFeedback()

  const choosePermission = async (next: ArrangementPermissionPreset) => {
    if (next === preset) return
    if (next === 'full-local') {
      const notice = capture()
      const accepted = await feedback.confirm({
        ...FULL_FILE_ACCESS_CONFIRMATION,
        key: 'default-conversation-full-file-access',
        title: '将新会话默认权限设为完全访问？',
        message: '新会话首次运行可读取和修改本机文件（含附件原件），发送时无需再次确认完全访问权限。',
        actionLabel: '设为默认',
      })
      if (!accepted || !notice.isCurrent()) return
    }
    save(next)
  }

  return <div className="ent-settings-permission-row">
    <div className="ent-settings-label">
      <label htmlFor="client-default-conversation-permission">新会话默认权限</label>
      <span id="client-default-conversation-permission-description">仅影响新会话。</span>
    </div>
    <select id="client-default-conversation-permission" aria-describedby="client-default-conversation-permission-description" value={preset} onChange={event => {
      const selected = RUN_PERMISSIONS.find(option => option.id === event.target.value)
      if (selected) void choosePermission(selected.id)
    }}>
      {RUN_PERMISSIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
    {error ? <p className="ent-profile-error" role="alert">{error}</p> : null}
  </div>
}
