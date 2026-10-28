import { ChartNoAxesCombined, Clapperboard, ClipboardList, Headset, Search, ShoppingBag } from 'lucide-react';
import type { RefObject } from 'react';

const examples = {
  conversation: [
    { title: '选品思路', icon: ShoppingBag, prompt: '推荐适合电商新手尝试的家居收纳类商品，从需求、竞争、物流和售后几个方面分析，给出选品建议。' },
    { title: '客服话术', icon: Headset, prompt: '整理电商客服应对催发货、物流延误、退换货和议价的常用话术，语气自然，不擅自承诺赔偿或优惠。' },
    { title: '直播脚本', icon: Clapperboard, prompt: '写一份家居收纳用品的直播带货通用脚本，包含开场、场景引入、产品介绍和互动环节，不编造商品参数、价格和功效。' },
  ],
  arrangement: [
    { title: '竞品调研', icon: Search, prompt: '调研公开渠道中的桌面收纳盒商品，对比价格区间、主要卖点和消费需求，输出竞品分析与差异化建议。注明资料来源，无法核实的信息明确标注。' },
    { title: '内容策划', icon: ClipboardList, prompt: '为家居收纳类电商账号制定一周内容计划，先梳理目标人群和使用场景，再输出每天的选题、标题和短视频脚本。' },
    { title: '上新方案', icon: ChartNoAxesCombined, prompt: '以桌面收纳盒为示例，制定电商上新方案，包含人群定位、卖点方向、商品标题、详情页结构和推广安排。明确标注假设，不编造实际销量和商品参数。' },
  ],
};

interface Props {
  mode: keyof typeof examples;
  disabled?: boolean;
  onSelect: (prompt: string) => void;
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement>;
}

export function PromptExamples({ mode, disabled = false, onSelect, inputRef }: Props) {
  const select = (prompt: string): void => {
    if (disabled) return;
    onSelect(prompt);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input?.isConnected) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };

  return (
    <div className="ent-prompt-examples" role="group" aria-label="电商提示词示例">
      {examples[mode].map(({ title, icon: Icon, prompt }) => (
        <button key={title} type="button" disabled={disabled} onClick={() => select(prompt)}>
          <Icon size={14} aria-hidden />
          <span>{title}</span>
        </button>
      ))}
    </div>
  );
}
