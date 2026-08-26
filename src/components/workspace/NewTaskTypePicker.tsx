import { ArrowRight, ListChecks, MessageCircle, Sparkles } from 'lucide-react';

interface Props {
  onConversation: () => void;
  onTaskCenter: () => void;
}

export function NewTaskTypePicker({ onConversation, onTaskCenter }: Props) {
  return (
    <section className="new-task-picker" aria-labelledby="new-task-title">
      <div className="new-task-picker-heading">
        <span className="eyebrow"><Sparkles size={14} />工作安排</span>
        <h1 id="new-task-title">今天想让团队完成什么？</h1>
        <p>先选择工作方式，再安排合适的硅基员工接手。</p>
      </div>
      <div className="new-task-options">
        <button className="new-task-option" onClick={onConversation} title="新建对话任务">
          <span className="new-task-option-icon"><MessageCircle size={22} /></span>
          <span className="new-task-option-copy"><strong>新建对话任务</strong><small>与一位或多位员工持续交流，适合分析、讨论和反复修改。</small></span>
          <ArrowRight size={18} className="new-task-option-arrow" />
        </button>
        <button className="new-task-option" onClick={onTaskCenter} title="打开任务中心">
          <span className="new-task-option-icon task-center"><ListChecks size={22} /></span>
          <span className="new-task-option-copy"><strong>任务中心</strong><small>编排多个员工完成一项工作，适合明确步骤和交付成果。</small></span>
          <ArrowRight size={18} className="new-task-option-arrow" />
        </button>
      </div>
    </section>
  );
}
