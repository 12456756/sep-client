import { Link, X } from 'lucide-react'
import { composerConnectorNames } from '../../../features/enterprise/composer-connectors'
import type { ConnectorId } from '../../../shared/connectors'

interface Props {
  value?: ConnectorId
  disabled?: boolean
  onRemove: () => void
}

export function ComposerConnectorChip({ value, disabled, onRemove }: Props): React.JSX.Element | null {
  if (!value) return null
  const name = composerConnectorNames[value]
  return <div className="sep-composer-connector-chip"><Link size={13} aria-hidden /><span>{name}</span><button type="button" disabled={disabled} aria-label={`移除${name}连接器`} title={`移除${name}连接器`} onClick={onRemove}><X size={12} aria-hidden /></button></div>
}
