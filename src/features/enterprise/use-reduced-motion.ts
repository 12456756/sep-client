/**
 * 动效开关。系统设置里选了「减少动态效果」时，编排过程仍然按同样的顺序走完
 * （那几步本身就是要让用户看见 AI 在做什么），但整条时间线压到三分之一，
 * 位移和缩放由 CSS 关掉 —— 见 arrange.css 的 prefers-reduced-motion 段。
 */

import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia?.(QUERY).matches ?? false);

  useEffect(() => {
    const media = window.matchMedia?.(QUERY);
    if (!media) return;
    const sync = () => setReduced(media.matches);
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  return reduced;
}
