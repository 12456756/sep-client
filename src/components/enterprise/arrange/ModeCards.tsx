/**
 * 「安排工作」的入口：先看懂流程，再选择适合自己的方式。
 *
 * 普通用户默认从对话式开始；自动编排和自己编排保留为高级入口，
 * 但不改变它们原有的真实业务流程。
 */

import { ArrowRight, MessageSquare, Sparkles, Workflow } from 'lucide-react';
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
  badge?: string;
  className?: string;
}[] = [
  {
    mode: 'chat',
    icon: MessageSquare,
    title: '对话式',
    desc: '与一个员工直接沟通，边聊边完成工作。适合第一次使用或目标还不够明确的工作。',
    cta: '开始对话',
    badge: '推荐',
    className: 'recommended',
  },
  {
    mode: 'auto',
    icon: Sparkles,
    title: '自动编排',
    desc: '告诉系统你的工作目标，AI 自动选择员工并安排工作。适合多人协作或流程较复杂的工作。',
    cta: '开始自动编排',
    badge: '高级模式',
    className: 'advanced',
  },
  {
    mode: 'manual',
    icon: Workflow,
    title: '自己编排',
    desc: '自己选择员工，并决定员工之间如何协作。适合已经明确流程和分工的工作。',
    cta: '自己设计流程',
    badge: '高级模式',
    className: 'advanced',
  },
];

export function ModeCards({ leaving, onPick }: Props) {
  return (
    <div className={`ent-arr-modes-wrap${leaving ? ' leaving' : ''}`}>
      <header className="ent-arr-head ent-arr-mode-head">
        <span className="ent-arr-kicker">安排工作 · 第 1 步</span>
        <h1>先选择一种工作方式</h1>
        <p>不确定怎么开始？选择「对话式」即可，后续仍可以在工作详情中继续推进。</p>
      </header>

      <ol className="ent-arr-steps" aria-label="安排工作流程">
        <li className="active"><span>01</span>选择方式</li>
        <li><span>02</span>选择员工</li>
        <li><span>03</span>描述目标</li>
        <li><span>04</span>确认并开始</li>
      </ol>

      <div className={`ent-arr-modes${leaving ? ' leaving' : ''}`}>
        {MODES.map(item => {
          const Icon = item.icon;
          return (
            <button
              key={item.mode}
              type="button"
              className={`ent-mode ${item.className ?? ''}`.trim()}
              onClick={() => onPick(item.mode)}
            >
              {item.badge ? <span className="ent-mode-badge">{item.badge}</span> : null}
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
    </div>
  );
}
