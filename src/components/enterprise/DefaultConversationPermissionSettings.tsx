import { useConversationPermissionPreference } from '../../features/enterprise/conversation-permission-scope'
import { RUN_PERMISSIONS } from '../../features/enterprise/run-settings'

export function DefaultConversationPermissionSettings() {
  const { preset, error, save } = useConversationPermissionPreference()
  return <div className="ent-settings-permission-row">
    <div className="ent-settings-label">
      <label htmlFor="client-default-conversation-permission">新会话默认权限</label>
      <span id="client-default-conversation-permission-description">仅影响新会话；完全访问仍需在发送时确认。</span>
    </div>
    <select id="client-default-conversation-permission" aria-describedby="client-default-conversation-permission-description" value={preset} onChange={event => {
      const selected = RUN_PERMISSIONS.find(option => option.id === event.target.value)
      if (selected) save(selected.id)
    }}>
      {RUN_PERMISSIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
    {error ? <p className="ent-profile-error" role="alert">{error}</p> : null}
  </div>
}
