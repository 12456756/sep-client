/**
 * 自动编排的推断，全部在本机完成。
 *
 * 平台还没有「按目标选人并排流程」的接口，所以这里用一条写死的规则链代替：
 * 目标里的说法 → 工作门类（客户 / 收集 / 分析 / 成文 / 复核）→ 门类对应的职能 → 具体的人。
 *
 * 界面上那个百分比是这条规则链算出来的**本地估值**（命中几条说法换算而来），
 * 不是平台给的评分，所以压在 68–96 之间，不出现「100% 匹配」这种过度承诺。
 * 接口开放后把 planAutoArrange 换成一次 IPC 调用即可，页面消费的是 AutoPlan，不用改。
 */

import type { SiliconEmployee, WorkDraftStep } from './types';
import { createDraftStep } from './work-graph';

/** 一个工作门类。 */
interface Aspect {
  id: string;
  /** 方案中的步骤名称。传入 deliverable 后可以生成与最终产物一致的名称。 */
  name: (deliverable: string) => string;
  /** 目标里出现这些说法，就认为这项工作需要这一门类。 */
  cues: string[];
  /** 优先由这些职能承担，越靠前越优先。 */
  roles: string[];
  /** 门类之间的先后：先摸清情况，再收集整理，然后分析，成文，最后复核。 */
  order: number;
  /** 这一步要做什么、需要什么、产出什么。 */
  work: (deliverable: string) => { title: string; input: string; output: string };
}

const ASPECTS: Aspect[] = [
  {
    id: 'support',
    name: () => '客户信息整理',
    cues: ['客户', '续约', '投诉', '反馈', '沟通', '往来', '回访', '跟进'],
    roles: ['客户支持', '资料整理'],
    order: 1,
    work: () => ({
      title: '整理客户往来信息，归纳待跟进事项与风险',
      input: '',
      output: '客户情况与待跟进清单',
    }),
  },
  {
    id: 'collect',
    name: () => '资料整理',
    cues: ['收集', '搜集', '整理', '汇总', '归档', '资料', '文件', '文档', '表格', '调研', '竞品', '市场', '查找'],
    roles: ['资料整理', '市场调研', '客户支持', '内容运营'],
    order: 2,
    work: () => ({
      title: '按工作目标收集并整理需要的资料',
      input: '',
      output: '整理好的资料与来源说明',
    }),
  },
  {
    id: 'analyze',
    name: () => '数据分析',
    cues: ['分析', '数据', '指标', '转化', '复盘', '统计', '对比', '趋势', '异常', '销售', '增长', '效果', '报表'],
    roles: ['数据分析', '审核校对'],
    order: 3,
    work: () => ({
      title: '分析上一步的资料，提取关键指标与异常',
      input: '上一步整理好的资料',
      output: '关键指标、结论与异常说明',
    }),
  },
  {
    id: 'write',
    name: deliverable => `生成${deliverable}`,
    cues: ['报告', '复盘', '周报', '月报', '简报', '纪要', '总结', '文案', '撰写', '生成', '输出', '方案', '邮件', '回复'],
    roles: ['内容运营', '客户支持', '资料整理'],
    order: 4,
    work: deliverable => ({
      title: `输出完整的${deliverable}`,
      input: '上一步的结论与关键指标',
      output: deliverable,
    }),
  },
  {
    id: 'review',
    name: () => '复核交付',
    cues: ['审核', '校对', '检查', '核对', '复核', '合规', '把关', '质量', '验收'],
    roles: ['审核校对', '数据分析'],
    order: 5,
    work: deliverable => ({
      title: '逐项核对内容与数字，标出需要你确认的地方',
      input: deliverable,
      output: '核对结论与待确认清单',
    }),
  },
];

/** 目标写得太短、命中不到两个门类时按这条链补齐 —— 一个人从头做到尾不算「安排工作」。 */
const DEFAULT_CHAIN = ['collect', 'analyze', 'write'];

/** 长的写在前面，否则「会议纪要」会先被「纪要」吃掉。 */
const DELIVERABLES = ['复盘报告', '分析报告', '会议纪要', '汇总表', '周报', '月报', '简报', '纪要', '清单', '方案', '文案', '邮件', '报告'];

/** 长的写在前面，否则「请帮我」会先被「请」截断。 */
const LEAD_WORDS = ['请帮我', '帮我', '麻烦你', '麻烦', '我想要', '我需要', '我想', '我要', '需要', '请'];

export interface AutoMatch {
  employee: SiliconEmployee;
  picked: boolean;
  /** 本地匹配度估值，68–96。 */
  match: number;
  /** 被选中时承担的工作阶段名，卡片上当匹配原因显示；没被选中时为空。 */
  stage: string;
}

export interface AutoStage {
  /** 工作名称，例如「数据分析」「生成复盘报告」。 */
  stage: string;
  employee: SiliconEmployee;
  match: number;
  /** 交给主进程执行的那一步。 */
  step: WorkDraftStep;
}

export interface AutoPlan {
  /** 工作名称，取目标的第一个短句。 */
  title: string;
  goal: string;
  /** 全部参与匹配的员工，顺序和员工列表一致 —— 筛选动画按这个顺序逐个扫描。 */
  pool: AutoMatch[];
  /** 最终的工作阶段，按先后顺序。 */
  stages: AutoStage[];
}

function cueHits(text: string, cues: string[]): number {
  let count = 0;
  for (const cue of cues) if (text.includes(cue)) count += 1;
  return count;
}

/** 这位员工有多适合这一门类。职能对上给得最多，擅长的事命中一条加一分。 */
function fitness(employee: SiliconEmployee, aspect: Aspect): number {
  let score = 0;
  const rank = aspect.roles.indexOf(employee.roleName);
  if (rank >= 0) score += 4 - Math.min(2, rank);
  score += employee.goodAt.filter(item => cueHits(item, aspect.cues) > 0).length;
  if (cueHits(employee.roleName, aspect.cues)) score += 1;
  // 同分时让现在就能开工的人接，正在忙的排后面。
  if (employee.availability === 'ready') score += 1;
  return score;
}

function percent(score: number): number {
  return Math.max(68, Math.min(96, 68 + score * 5));
}

function deliverableOf(goal: string): string {
  return DELIVERABLES.find(item => goal.includes(item)) ?? '结果说明';
}

/** 取目标的第一个短句当工作名称。先去掉「帮我」这类开场词，再切到第一个标点。 */
function titleOf(goal: string): string {
  let text = goal.trim();
  for (;;) {
    const lead = LEAD_WORDS.find(word => text.startsWith(word));
    if (!lead) break;
    text = text.slice(lead.length).trim();
  }
  const cut = text.search(/[，。,.;；、!！?？\n]/);
  const head = (cut > 0 ? text.slice(0, cut) : text).trim();
  if (!head) return '未命名工作';
  return head.length > 24 ? `${head.slice(0, 24)}…` : head;
}

/** 目标 → 需要哪几个门类，按先后排好。 */
function chainOf(goal: string, limit: number): Aspect[] {
  const wanted = ASPECTS
    .map(aspect => ({ aspect, weight: cueHits(goal, aspect.cues) }))
    .filter(entry => entry.weight > 0)
    .sort((left, right) => right.weight - left.weight || left.aspect.order - right.aspect.order)
    .slice(0, limit)
    .map(entry => entry.aspect);
  for (const id of DEFAULT_CHAIN) {
    if (wanted.length >= limit) break;
    const aspect = ASPECTS.find(item => item.id === id);
    if (aspect && !wanted.includes(aspect)) wanted.push(aspect);
  }
  return wanted.sort((left, right) => left.order - right.order);
}

/**
 * 按目标选人并排出流程。employees 必须是「现在能派活的人」——
 * 暂时不可用的员工不该出现在筛选动画里，选中了也开不了工。
 */
export function planAutoArrange(goal: string, employees: SiliconEmployee[]): AutoPlan | null {
  const text = goal.trim();
  if (!text || !employees.length) return null;

  const deliverable = deliverableOf(text);
  const chain = chainOf(text, Math.min(3, employees.length));

  const taken = new Set<string>();
  const stages: AutoStage[] = [];
  for (const aspect of chain) {
    const free = employees.filter(item => !taken.has(item.id));
    const best = free[0];
    if (!best) break;
    const winner = free.reduce((win, item) => (fitness(item, aspect) > fitness(win, aspect) ? item : win), best);
    taken.add(winner.id);
    const work = aspect.work(deliverable);
    const previous = stages[stages.length - 1];
    stages.push({
      stage: aspect.name(deliverable),
      employee: winner,
      match: percent(fitness(winner, aspect)),
      step: {
        ...createDraftStep(winner.id),
        title: work.title,
        input: work.input,
        output: work.output,
        dependsOn: previous ? [previous.step.id] : [],
      },
    });
  }
  if (!stages.length) return null;

  const pool: AutoMatch[] = employees.map(employee => {
    const stage = stages.find(item => item.employee.id === employee.id);
    if (stage) return { employee, picked: true, match: stage.match, stage: stage.stage };
    const best = Math.max(...chain.map(aspect => fitness(employee, aspect)));
    return { employee, picked: false, match: percent(best), stage: '' };
  });

  return { title: titleOf(text), goal: text, pool, stages };
}


