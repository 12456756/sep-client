/**
 * 「安排工作」的入口：三种安排方式，一眼选一个。
 *
 * 三张卡视觉完全一致，只有内容不同 —— 差别靠图标、标题和一句说明表达，
 * 不靠大小或颜色分主次。自动编排是三者里最重要的一个，只给它一条极淡的
 * 顶部紫线作为提示，不放大、不换底色。
 *
 * 点卡片不立即跳转：先让这一屏淡出（见 ArrangeWorkPage 的 leave），
 * 再换到下一屏，避免整页硬切。
 */

import { ArrowRight, GitBranch, MessageSquare, Sparkles } from 'lucide-react';
import type { ArrangeMode } from '../../../features/enterprise/types';

interface Props {
  /** 正在淡出的目标模式。有值时这一屏整体淡出。 */
  leaving: ArrangeMode | null;
  onPick: (mode: ArrangeMode) => void;
}

const MODES: {
  mode: ArrangeMode;
  icon: typeof MessageSquare;
  title: string;
  desc: string;
  cta: string;
  featured?: boolean;
}[] = [
  {
    mode: 'chat',
    icon: MessageSquare,
    title: '对话式',
    desc: '与一个员工直接沟通，边聊边完成工作。',
    cta: '开始对话',
  },
  {
    mode: 'auto',
    icon: Sparkles,
    title: '自动编排',
    desc: '告诉系统你的工作目标，AI 自动选择员工并安排工作。',
    cta: '开始',
    featured: true,
  },
  {
    mode: 'manual',
    icon: GitBranch,
    title: '自己编排',
    desc: '自己选择员工，并决定员工之间如何协作。',
    cta: '开始',
  },
];

export function ModeCards({ leaving, onPick }: Props) {
  return (
    <div className={`ent-arr-modes${leaving ? ' leaving' : ''}`}>
      {MODES.map(item => {
        const Icon = item.icon;
        return (
          <button
            key={item.mode}
            type="button"
            className={`ent-mode${item.featured ? ' featured' : ''}`}
            onClick={() => onPick(item.mode)}
          >
            <span className="ent-mode-icon" aria-hidden>
              <Icon size={22} />
            </span>
            <strong className="ent-mode-title">{item.title}</strong>
            <span className="ent-mode-desc">{item.desc}</span>
            <span className="ent-mode-cta">
              {item.cta}
              <ArrowRight size={14} aria-hidden />
            </span>
          </button>
        );
      })}
    </div>
  );
}


