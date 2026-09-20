import type { AvailableEmployee } from '../../features/workspace/useWorkspaceDemo'
import { EmployeeFace } from '../enterprise/EmployeeFace'

export function WorkspaceEmployeeAvatar({ employee, className }: { employee: AvailableEmployee; className?: string }): React.JSX.Element {
  return (
    <EmployeeFace
      employee={{ name: employee.displayName, avatar: employee.avatar, avatarAsset: employee.avatarAsset }}
      size="sm"
      className={`workspace-avatar-face${className ? ` ${className}` : ''}`}
    />
  )
}
