/**
 * 编排画布的图运算：依赖校验、成环判断、自动布局、并行度统计、旧数据升级。
 *
 * 这里的校验规则与主进程的安排节点校验保持一致：检查重复 id、缺失依赖、自依赖和成环。
 * 渲染层要自己校验一遍，是为了让用户在连线的那一刻就知道不行 ——
 * 等到点「开始工作」再由主进程报错，用户已经不知道是哪一根线的问题了。
 */

import type { WorkDraftStep } from './types';

/**
 * 节点尺寸与自动布局的间距。
 *
 * 高度是**固定值**而不是最小值：连线端点要落在两侧端口的圆心上，
 * 端口是 top:50%，所以必须知道节点确切多高。让高度随内容伸缩的话，
 * 连线就会连到节点中部偏上或偏下的一个错位置去。
 */
export const NODE_W = 248;
export const NODE_H = 128;
/** 端口圆心相对节点边缘的偏移。端口 13px 宽、left/right: -7px，所以圆心在边缘外 0.5px。 */
export const PORT_OUT = 0.5;
/**
 * 端口半径。连线从端口圆的外缘出发、到对面端口圆的外缘为止 ——
 * 画到圆心的话，箭头会被端口那个实心圆整个盖住（节点在 SVG 之上绘制）。
 */
export const PORT_R = 6.5;
const LAYER_GAP = 316;
const ROW_GAP = 168;
const ORIGIN = 40;

/** 拖动时吸附到这个网格，避免节点位置差一两个像素看起来没对齐。 */
export const GRID = 8;

let seq = 0;

/**
 * 新建一个步骤。id 直接生成成主进程能接受的安全形式（^[A-Za-z0-9_-]{1,128}$），
 * 这样就不需要在提交前再洗一遍 —— 洗过的两个不同 id 可能撞成同一个，
 * 重复 id 会在提交前直接拒绝。
 */
export function createDraftStep(employeeId: string, at?: { x: number; y: number }): WorkDraftStep {
  seq += 1;
  return {
    id: `s${Date.now().toString(36)}-${seq}`,
    employeeId,
    title: '',
    input: '',
    output: '',
    dependsOn: [],
    needsConfirm: false,
    skillIds: [],
    x: at?.x ?? ORIGIN,
    y: at?.y ?? ORIGIN,
  };
}

/** 按依赖关系分层：入度为 0 的在第 0 层，其余是「所有前置的最大层数 + 1」。 */
export function layerOf(steps: WorkDraftStep[]): Map<string, number> {
  const byId = new Map(steps.map(step => [step.id, step]));
  const layers = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const cached = layers.get(id);
    if (cached !== undefined) return cached;
    // 有环时不能无限递归。环本身由 validateGraph 报错，这里只要不挂。
    if (seen.has(id)) return 0;
    seen.add(id);
    const step = byId.get(id);
    const deps = (step?.dependsOn ?? []).filter(dep => byId.has(dep));
    const value = deps.length ? Math.max(...deps.map(dep => visit(dep, seen))) + 1 : 0;
    seen.delete(id);
    layers.set(id, value);
    return value;
  };
  steps.forEach(step => visit(step.id, new Set()));
  return layers;
}

/** 同时最多有几步可以开工 = 最宽的一层有几个节点。 */
export function maxParallel(steps: WorkDraftStep[]): number {
  if (!steps.length) return 0;
  const layers = layerOf(steps);
  const width = new Map<number, number>();
  for (const step of steps) {
    const layer = layers.get(step.id) ?? 0;
    width.set(layer, (width.get(layer) ?? 0) + 1);
  }
  return Math.max(...width.values());
}

/** 自动布局。只用在「从模板/已保存/复制工作带进来」这些没有坐标的场合。 */
export function layoutSteps(steps: WorkDraftStep[]): WorkDraftStep[] {
  const layers = layerOf(steps);
  const used = new Map<number, number>();
  return steps.map(step => {
    const layer = layers.get(step.id) ?? 0;
    const row = used.get(layer) ?? 0;
    used.set(layer, row + 1);
    return { ...step, x: ORIGIN + layer * LAYER_GAP, y: ORIGIN + row * ROW_GAP };
  });
}

/**
 * 点员工列表（而不是拖）时新步骤摆在哪。
 * 键盘用户只能点，所以这个路径必须存在，不能只支持拖拽。
 */
export function nextSpot(steps: WorkDraftStep[]): { x: number; y: number } {
  if (!steps.length) return { x: ORIGIN, y: ORIGIN };
  const maxX = Math.max(...steps.map(step => step.x));
  const column = steps.filter(step => step.x === maxX);
  if (column.length >= 3) return { x: maxX + LAYER_GAP, y: ORIGIN };
  return { x: maxX, y: Math.max(...column.map(step => step.y)) + ROW_GAP };
}

/**
 * 从 A 连到 B 会不会绕回自己。判断方式是「B 是否已经是 A 的上游」：
 * 如果是，再加 A→B 就成环了。
 */
export function wouldCycle(steps: WorkDraftStep[], fromId: string, toId: string): boolean {
  if (fromId === toId) return true;
  const byId = new Map(steps.map(step => [step.id, step]));
  const seen = new Set<string>();
  const upstream = (id: string): boolean => {
    if (id === toId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (byId.get(id)?.dependsOn ?? []).some(upstream);
  };
  return upstream(fromId);
}

/** 一个步骤缺什么才不能开工。返回空数组表示这一步填全了。 */
export function stepProblems(step: WorkDraftStep): string[] {
  const out: string[] = [];
  if (!step.employeeId) out.push('还没有指定硅基员工');
  if (!step.title.trim()) out.push('还没有写工作内容');
  return out;
}

/**
 * 整张图能不能开工。返回第一条人话错误，null 表示可以。
 * 顺序刻意和用户的注意力一致：先说「有没有步骤」，再说「步骤填全了吗」，最后才说结构问题。
 */
export function validateGraph(steps: WorkDraftStep[]): string | null {
  if (!steps.length) return '还没有工作步骤。从左边把一位同事拖进来就是第一步。';

  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) return '有两个工作步骤重复了，删掉一个再开始。';
    ids.add(step.id);
  }

  const bad = steps.find(step => stepProblems(step).length);
  if (bad) return `有工作步骤${stepProblems(bad)[0]}，补齐之后才能开始。`;

  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (dep === step.id) return '有一个工作步骤连到了自己，这样它永远等不到开始。';
      if (!ids.has(dep)) return '有一条连线指向已经被删掉的工作步骤，重新连一下。';
    }
  }

  const visiting = new Set<string>();
  const done = new Set<string>();
  const byId = new Map(steps.map(step => [step.id, step]));
  let cyclic = false;
  const visit = (id: string): void => {
    if (cyclic || done.has(id)) return;
    if (visiting.has(id)) { cyclic = true; return; }
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
    visiting.delete(id);
    done.add(id);
  };
  steps.forEach(step => visit(step.id));
  if (cyclic) return '有几个工作步骤互相等待，绕成了一个圈，这样工作没法结束。';

  return null;
}

/**
 * 旧数据升级。v1 的步骤是线性链（带 inheritPrevious、没有坐标、没有技能包），
 * 按「每一步依赖上一步」还原成依赖图，再补上自动布局。
 * 不升级的话历史「常用工作」和「复制为新工作」带进画布会全部断链。
 */
export function upgradeDraftSteps(raw: unknown): WorkDraftStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: WorkDraftStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const source = item as Record<string, unknown>;
    if (typeof source.id !== 'string' || typeof source.employeeId !== 'string') continue;
    const previous = steps[steps.length - 1];
    const dependsOn = Array.isArray(source.dependsOn)
      ? source.dependsOn.filter((dep): dep is string => typeof dep === 'string')
      : source.inheritPrevious && previous ? [previous.id] : [];
    steps.push({
      id: source.id,
      employeeId: source.employeeId,
      title: typeof source.title === 'string' ? source.title : '',
      input: typeof source.input === 'string' ? source.input : '',
      output: typeof source.output === 'string' ? source.output : '',
      dependsOn,
      needsConfirm: source.needsConfirm === true,
      skillIds: Array.isArray(source.skillIds) ? source.skillIds.filter((id): id is string => typeof id === 'string') : [],
      x: typeof source.x === 'number' ? source.x : 0,
      y: typeof source.y === 'number' ? source.y : 0,
    });
  }
  // 一个坐标都没有说明是旧数据或模板，整体重新布局；有坐标就尊重用户摆好的位置。
  return steps.some(step => step.x || step.y) ? steps : layoutSteps(steps);
}


