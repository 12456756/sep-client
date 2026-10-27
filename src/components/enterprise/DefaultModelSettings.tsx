import { useModelPreference } from '../workspace/model-preference-scope'

export function DefaultModelSettings({ models }: { models: readonly string[] }) {
  const { defaultModelId, error, save } = useModelPreference()
  const unavailable = Boolean(defaultModelId && !models.includes(defaultModelId))
  return <div className="ent-default-model-settings">
    <label htmlFor="client-default-model">默认模型</label>
    <select id="client-default-model" value={defaultModelId} onChange={event => save(event.target.value)}>
      <option value="">跟随系统默认</option>
      {unavailable ? <option value={defaultModelId} disabled>{defaultModelId}（当前不可用）</option> : null}
      {models.map(model => <option key={model} value={model}>{model}</option>)}
    </select>
    {error ? <p className="ent-profile-error" role="alert">{error}</p> : null}
  </div>
}
