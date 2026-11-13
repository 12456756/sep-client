import { Plus } from 'lucide-react'
import { lazy, Suspense, type ComponentProps } from 'react'

const Menu = lazy(() => import('../home/ComposerAddMenu').then(module => ({ default: module.ComposerAddMenu })))

export function ComposerAddMenuLoader(props: ComponentProps<typeof Menu>): React.JSX.Element {
  return <Suspense fallback={<button type="button" disabled aria-label="添加菜单加载中"><Plus size={20} aria-hidden /></button>}><Menu {...props} /></Suspense>
}
