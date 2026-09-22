/**
 * Phase 4: 模式轮播切换器 - 顶部横向滑动的三种派活模式
 *
 * 设计规范：
 * - 48px 高，三个模式横向排列
 * - 当前模式底部 terracotta 下划线（3px 粗）
 * - 支持点击切换，切换时清空当前会话
 * - 流畅过渡动画（300ms ease-in-out）
 */

import { MessageSquare, Sparkles, Workflow } from 'lucide-react';
import type { ArrangeMode } from '../../../features/enterprise/types';

interface Props {
  currentMode: ArrangeMode;
  onSwitch: (mode: ArrangeMode) => void;
}

const MODES: {
  mode: ArrangeMode;
  icon: typeof MessageSquare;
  label: string;
}[] = [
  { mode: 'chat', icon: MessageSquare, label: '💬 对话式派活' },
  { mode: 'auto', icon: Sparkles, label: '⚡ 自动编排' },
  { mode: 'manual', icon: Workflow, label: '🛠️ 手动编排' },
];

export function ModeCarousel({ currentMode, onSwitch }: Props) {
  return (
    <div className="ent-arr-carousel" role="tablist" aria-label="派活模式">
      {MODES.map((item) => {
        const Icon = item.icon;
        const isActive = item.mode === currentMode;
        return (
          <button
            key={item.mode}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`ent-arr-carousel-item${isActive ? ' active' : ''}`}
            onClick={() => onSwitch(item.mode)}
          >
            <Icon size={16} aria-hidden />
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
