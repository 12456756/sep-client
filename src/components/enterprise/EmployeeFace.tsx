import * as React from 'react'
import type { EmployeeAvatarSource } from '../../shared/types'
import { avatarCacheKey, avatarCandidates, type AvatarVariant } from '../../features/enterprise/avatar'

type Size = 'sm' | 'md' | 'lg' | 'xl' | 'card'

interface Props {
  /** SEP employee data. The component never derives an avatar URL from an id or name. */
  employee?: EmployeeAvatarSource | null
  /** Used for the initials placeholder when a complete employee object is unavailable. */
  name?: string
  /** Kept for source compatibility with older callers; it is not used to select an avatar. */
  seed?: string
  size?: Size
  /** Circle crop for list/chat avatars; employee cards generally use rounded rectangles. */
  round?: boolean
  /** face for lists and chat bubbles; portrait for detail/header images. */
  variant?: AvatarVariant
  className?: string
}

function initialsOf(employee: EmployeeAvatarSource | null | undefined, name?: string): string {
  const value = employee?.name ?? name ?? ''
  return value.trim().slice(0, 1) || '?'
}

export function EmployeeFace({
  employee = null,
  name,
  seed: _seed,
  size = 'md',
  round = false,
  variant = 'face',
  className,
}: Props): React.JSX.Element {
  const candidates = React.useMemo(
    () => (employee ? avatarCandidates(employee, variant) : []),
    [employee, variant],
  )
  const cacheKey = React.useMemo(
    () => (employee ? avatarCacheKey(employee, variant) : `avatar:placeholder:${variant}`),
    [employee, variant],
  )
  const [failedCount, setFailedCount] = React.useState(0)

  React.useEffect(() => {
    setFailedCount(0)
  }, [cacheKey])

  const src = candidates[failedCount]
  const classNames = `ent-face ${size}${round ? ' round' : ''}${className ? ` ${className}` : ''}`

  if (!src) {
    return (
      <span className={`${classNames} placeholder`} aria-hidden>
        {initialsOf(employee, name)}
      </span>
    )
  }

  return (
    <span className={classNames} aria-hidden>
      <img
        key={`${cacheKey}:${failedCount}`}
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailedCount(current => Math.min(current + 1, candidates.length))}
      />
    </span>
  )
}
