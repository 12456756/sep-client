/**
 * 编排画布。节点是绝对定位的 DOM，连线是一层 SVG，平移缩放是一个 CSS transform。
 *
 * 为什么不用 <canvas>，也不引入 react-flow：
 * DOM 节点白拿焦点、Tab 顺序、屏幕阅读器、文字渲染和现有 --ent-* 样式；
 * <canvas> 要自己写命中测试、自己画文字，无障碍为零；
 * react-flow 是新框架，而且它的默认视觉正是我们不要的工程化编排器风格。
 *
 * 这是一个受控组件：步骤、选中项、视图变换都由 ArrangeWorkPage 持有 ——
 * 因为「从左侧员工列表拖进画布」这个手势跨越了两个区域，坐标换算必须在同一处做。
 */

import { AlertTriangle, Eraser, GripVertical, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { EmployeeSkill, SiliconEmployee, WorkDraftStep } from '../../features/enterprise/types';
import { GRID, NODE_H, NODE_W, PORT_OUT, PORT_R, stepProblems, wouldCycle } from '../../features/enterprise/work-graph';
import { EmployeeFace } from './EmployeeFace';

export interface CanvasView {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.6;
const MAX_SCALE = 1.4;

interface Props {
  steps: WorkDraftStep[];
  employees: SiliconEmployee[];
  skills: EmployeeSkill[];
  selectedId: string | null;
  view: CanvasView;
  /** 从左侧员工列表拖动时的落点提示，null 表示没有在拖。 */
  dropHint: { x: number; y: number } | null;
  viewportRef: React.RefObject<HTMLDivElement>;
  /**
   * 这个值一变就把全部节点归位到视野内。
   * 用在「载入模板 / 已保存的常用工作 / 复制为新工作」之后 ——
   * 自动布局产生的节点可能超出当前视野，用户会以为只铺了两步。
   */
  fitKey: number;
  /**
   * 右侧被浮层遮住的宽度。选中的节点要留在这个区域之外，
   * 否则「拖进第一个人 → 面板弹出」时那个节点正好被面板压住，用户看不到自己刚放下的东西。
   */
  reservedRight: number;
  onView: (view: CanvasView) => void;
  onSelect: (id: string | null) => void;
  onChange: (steps: WorkDraftStep[]) => void;
  /** 连线被拒绝等需要当场告诉用户的事。 */
  onNotice: (text: string) => void;
}

type Drag =
  | { kind: 'node'; id: string; offsetX: number; offsetY: number }
  | { kind: 'pan'; fromX: number; fromY: number; baseX: number; baseY: number }
  | { kind: 'edge'; fromId: string; px: number; py: number };

export function WorkCanvas({
  steps, employees, skills, selectedId, view, dropHint, viewportRef, fitKey, reservedRight,
  onView, onSelect, onChange, onNotice,
}: Props) {
  const [drag, setDrag] = useState<Drag | null>(null);
  /** 「清空画布」的二次确认。切页或步骤被清空后自动复位。 */
  const [asking, setAsking] = useState(false);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  useEffect(() => {
    if (!steps.length) setAsking(false);
  }, [steps.length]);

  /** 屏幕坐标 → 画布坐标。视图变换在这里反解，别的地方不要再算一遍。 */
  const toCanvas = (clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left - view.x) / view.scale, y: (clientY - rect.top - view.y) / view.scale };
  };

  // 拖动过程挂在 window 上：指针滑出画布边界时不能中断，否则节点会粘在半路。
  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      if (current.kind === 'pan') {
        onView({ ...view, x: current.baseX + (event.clientX - current.fromX), y: current.baseY + (event.clientY - current.fromY) });
        return;
      }
      const point = toCanvas(event.clientX, event.clientY);
      if (current.kind === 'node') {
        const x = Math.round((point.x - current.offsetX) / GRID) * GRID;
        const y = Math.round((point.y - current.offsetY) / GRID) * GRID;
        onChange(steps.map(step => (step.id === current.id ? { ...step, x, y } : step)));
        return;
      }
      setDrag({ ...current, px: point.x, py: point.y });
    };
    const up = (event: PointerEvent) => {
      const current = dragRef.current;
      if (current?.kind === 'edge') {
        const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-step-id]');
        const toId = target?.dataset.stepId;
        if (toId && toId !== current.fromId) connect(current.fromId, toId);
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  });

  /** 加一条「A 完成后交给 B」。成环当场拒绝，不等到点开始工作才由主进程报错。 */
  const connect = (fromId: string, toId: string) => {
    const target = steps.find(step => step.id === toId);
    if (!target) return;
    if (target.dependsOn.includes(fromId)) { onNotice('这两步已经连过了。'); return; }
    if (wouldCycle(steps, fromId, toId)) {
      onNotice('这样会绕回到自己，工作就没法结束了。换一个方向连。');
      return;
    }
    onChange(steps.map(step => (step.id === toId ? { ...step, dependsOn: [...step.dependsOn, fromId] } : step)));
  };

  const disconnect = (fromId: string, toId: string) => {
    onChange(steps.map(step => (step.id === toId ? { ...step, dependsOn: step.dependsOn.filter(dep => dep !== fromId) } : step)));
  };

  const removeStep = (id: string) => {
    onChange(steps.filter(step => step.id !== id).map(step => ({ ...step, dependsOn: step.dependsOn.filter(dep => dep !== id) })));
    onSelect(null);
  };

  const nudge = (id: string, dx: number, dy: number) => {
    onChange(steps.map(step => (step.id === id ? { ...step, x: step.x + dx, y: step.y + dy } : step)));
  };

  const zoom = (delta: number, at?: { clientX: number; clientY: number }) => {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number((view.scale + delta).toFixed(2))));
    if (next === view.scale) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || !at) { onView({ ...view, scale: next }); return; }
    // 以指针位置为锚点缩放，否则内容会往左上角跑。
    const px = at.clientX - rect.left;
    const py = at.clientY - rect.top;
    const ratio = next / view.scale;
    onView({ scale: next, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio });
  };

  /** 双击空白处把全部节点归位到视野中间。 */
  const fitToView = () => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || !steps.length) { onView({ x: 0, y: 0, scale: 1 }); return; }
    const left = Math.min(...steps.map(step => step.x));
    const top = Math.min(...steps.map(step => step.y));
    const right = Math.max(...steps.map(step => step.x + NODE_W));
    const bottom = Math.max(...steps.map(step => step.y + NODE_H));
    const scale = Math.min(1, Math.max(MIN_SCALE, Math.min((rect.width - 64) / (right - left), (rect.height - 64) / (bottom - top))));
    onView({
      scale,
      x: (rect.width - (right - left) * scale) / 2 - left * scale,
      y: (rect.height - (bottom - top) * scale) / 2 - top * scale,
    });
  };

  // 载入模板／已保存的安排之后自动归位。自动布局摆出来的节点可能在视野外，
  // 不归位用户会以为只铺了前两步。fitKey 由上层在「整批换掉步骤」时递增。
  const fitRef = useRef(fitToView);
  fitRef.current = fitToView;
  useEffect(() => {
    if (!fitKey) return;
    fitRef.current();
  }, [fitKey]);

  /**
   * 选中的节点不能被右侧浮层压住。只在必要时横向挪一点，
   * 不做「居中到视野」那种大动作 —— 用户刚摆好的其他节点也会跟着跑，很难受。
   */
  const selected = steps.find(step => step.id === selectedId);
  const nudgeIntoSight = useRef<() => void>(() => undefined);
  nudgeIntoSight.current = () => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || !selected) return;
    const visibleRight = rect.width - reservedRight - 16;
    const right = view.x + (selected.x + NODE_W) * view.scale;
    const left = view.x + selected.x * view.scale;
    if (right <= visibleRight && left >= 16) return;
    const shift = right > visibleRight ? visibleRight - right : 16 - left;
    onView({ ...view, x: view.x + shift });
  };
  useEffect(() => {
    nudgeIntoSight.current();
  }, [selectedId, reservedRight]);

  return (
    <div
      className={`ent-canvas${drag ? ` dragging-${drag.kind}` : ''}${dropHint ? ' dropping' : ''}`}
      ref={viewportRef}
      onPointerDown={event => {
        if ((event.target as HTMLElement).closest('[data-step-id], .ent-edge-cut')) return;
        onSelect(null);
        setDrag({ kind: 'pan', fromX: event.clientX, fromY: event.clientY, baseX: view.x, baseY: view.y });
      }}
      onDoubleClick={event => { if (!(event.target as HTMLElement).closest('[data-step-id]')) fitToView(); }}
      onWheel={event => {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          zoom(event.deltaY > 0 ? -0.1 : 0.1, event);
        } else {
          onView({ ...view, x: view.x - event.deltaX, y: view.y - event.deltaY });
        }
      }}
    >
      <div className="ent-canvas-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        <Edges steps={steps} drag={drag} selectedId={selectedId} onCut={disconnect} />
        {steps.map(step => (
          <Node
            key={step.id}
            step={step}
            employee={employees.find(item => item.id === step.employeeId)}
            skills={skills}
            selected={step.id === selectedId}
            connecting={drag?.kind === 'edge'}
            onSelect={() => onSelect(step.id)}
            onRemove={() => removeStep(step.id)}
            onNudge={(dx, dy) => nudge(step.id, dx, dy)}
            onDragStart={(offsetX, offsetY) => setDrag({ kind: 'node', id: step.id, offsetX, offsetY })}
            onEdgeStart={() => setDrag({ kind: 'edge', fromId: step.id, px: step.x + NODE_W, py: step.y + NODE_H / 2 })}
            toCanvas={toCanvas}
          />
        ))}
        {dropHint ? (
          <div className="ent-canvas-ghost" style={{ transform: `translate(${dropHint.x}px, ${dropHint.y}px)` }} aria-hidden>
            放在这里
          </div>
        ) : null}
      </div>

      {!steps.length && !dropHint ? (
        <div className="ent-canvas-empty">
          <strong>从左边把一位同事拖进来</strong>
          <span>拖进来就成为第一个工作步骤。再拖一位，从他右侧的圆点连过去，就是「做完交给下一位」。</span>
        </div>
      ) : null}

      <div className="ent-canvas-tools">
        <button type="button" onClick={() => zoom(-0.1)} aria-label="缩小">−</button>
        <span>{Math.round(view.scale * 100)}%</span>
        <button type="button" onClick={() => zoom(0.1)} aria-label="放大">+</button>
        <button type="button" onClick={fitToView}>归位</button>
        {/*
          清空是唯一会一次性丢掉全部编排的动作，所以问一遍再执行。
          用就地二次确认而不是浏览器弹窗：弹窗会打断手上的编排节奏。
        */}
        {steps.length ? (
          asking ? (
            <span className="ent-canvas-ask">
              <button type="button" className="warn" onClick={() => { onChange([]); onSelect(null); setAsking(false); }}>
                确认清空
              </button>
              <button type="button" onClick={() => setAsking(false)}>取消</button>
            </span>
          ) : (
            <button type="button" onClick={() => setAsking(true)}>
              <Eraser size={13} aria-hidden />
              清空
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}

/**
 * 连线层。一条线画三样东西：命中用的粗透明线、看得见的细线（末端带箭头）、中点的删除按钮。
 * 粗透明线是必须的 —— 2px 的曲线用鼠标根本点不到。
 *
 * 端点落在两侧端口的圆心上（不是节点边框上），所以看起来是「从这个点连到那个点」；
 * 箭头用 SVG marker，方向由 orient="auto" 跟着曲线末端的切线走。
 */
function Edges({ steps, drag, selectedId, onCut }: {
  steps: WorkDraftStep[];
  drag: Drag | null;
  selectedId: string | null;
  onCut: (fromId: string, toId: string) => void;
}) {
  const byId = new Map(steps.map(step => [step.id, step]));
  const edges: { from: WorkDraftStep; to: WorkDraftStep }[] = [];
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      const from = byId.get(dep);
      if (from) edges.push({ from, to: step });
    }
  }

  const live = drag?.kind === 'edge' ? byId.get(drag.fromId) : undefined;

  return (
    <svg className="ent-canvas-edges" aria-hidden>
      <defs>
        {/* refX 取到箭头尖端，这样尖端正好落在路径终点（也就是目标端口圆的外缘）。 */}
        <marker id="ent-arrow" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0.5 L10 5 L0 9.5 z" className="ent-arrow-head" />
        </marker>
        <marker id="ent-arrow-on" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0.5 L10 5 L0 9.5 z" className="ent-arrow-head on" />
        </marker>
      </defs>
      {edges.map(({ from, to }) => {
        const x1 = from.x + NODE_W + PORT_OUT + PORT_R;
        const y1 = from.y + NODE_H / 2;
        const x2 = to.x - PORT_OUT - PORT_R;
        const y2 = to.y + NODE_H / 2;
        const path = curve(x1, y1, x2, y2);
        const on = selectedId === from.id || selectedId === to.id;
        return (
          <g key={`${from.id}->${to.id}`} className={`ent-edge${on ? ' on' : ''}`}>
            <path className="ent-edge-hit" d={path} />
            <path className="ent-edge-line" d={path} />
            <g
              className="ent-edge-cut"
              transform={`translate(${(x1 + x2) / 2}, ${(y1 + y2) / 2})`}
              role="button"
              tabIndex={0}
              aria-label={`断开「${from.title || '未命名步骤'}」到「${to.title || '未命名步骤'}」的连接`}
              onPointerDown={event => { event.stopPropagation(); onCut(from.id, to.id); }}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onCut(from.id, to.id); } }}
            >
              <circle r="9" />
              <path d="M-3.5 -3.5 L3.5 3.5 M3.5 -3.5 L-3.5 3.5" />
            </g>
          </g>
        );
      })}
      {live && drag?.kind === 'edge' ? (
        <path className="ent-edge-live" d={curve(live.x + NODE_W + PORT_OUT + PORT_R, live.y + NODE_H / 2, drag.px, drag.py)} />
      ) : null}
    </svg>
  );
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const bend = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

/**
 * 一个工作步骤节点。表现的是「一位硅基员工正在负责的一项具体工作」，
 * 不是 Agent 节点 —— 所以先是人（头像、姓名、职位），再是这项工作的内容和用到的能力。
 *
 * 节点用 div + role=button 而不是 <button>：里面还有两个连线端口是真的 button，
 * button 套 button 是非法结构。键盘可达性由 tabIndex 和 onKeyDown 自己补上。
 */
function Node({ step, employee, skills, selected, connecting, onSelect, onRemove, onNudge, onDragStart, onEdgeStart, toCanvas }: {
  step: WorkDraftStep;
  employee: SiliconEmployee | undefined;
  skills: EmployeeSkill[];
  selected: boolean;
  connecting: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onNudge: (dx: number, dy: number) => void;
  onDragStart: (offsetX: number, offsetY: number) => void;
  onEdgeStart: () => void;
  toCanvas: (clientX: number, clientY: number) => { x: number; y: number };
}) {
  const problems = stepProblems(step);
  const capability = capabilityLine(step, employee, skills);

  return (
    <div
      className={`ent-node${selected ? ' selected' : ''}${problems.length ? ' unfinished' : ''}${connecting ? ' targetable' : ''}`}
      style={{ transform: `translate(${step.x}px, ${step.y}px)` }}
      data-step-id={step.id}
      role="button"
      tabIndex={0}
      aria-label={`工作步骤：${employee?.name ?? '未指定员工'}，${step.title || '还没有写工作内容'}`}
      aria-pressed={selected}
      onPointerDown={event => {
        if ((event.target as HTMLElement).closest('.ent-node-port, .ent-node-del')) return;
        onSelect();
        const point = toCanvas(event.clientX, event.clientY);
        onDragStart(point.x - step.x, point.y - step.y);
      }}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(); return; }
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); onRemove(); return; }
        const move: Record<string, [number, number]> = {
          ArrowLeft: [-GRID, 0], ArrowRight: [GRID, 0], ArrowUp: [0, -GRID], ArrowDown: [0, GRID],
        };
        const delta = move[event.key];
        if (delta) { event.preventDefault(); onNudge(delta[0], delta[1]); }
      }}
    >
      {/* 入口端口只是落点，没有单独的拖拽行为，所以不做成可聚焦按钮。 */}
      <span className="ent-node-port in" aria-hidden />

      <div className="ent-node-head">
        <EmployeeFace seed={employee?.id ?? step.id} size="sm" round />
        <span className="ent-node-id">
          <strong>{employee?.name ?? '未指定员工'}</strong>
          <small>{employee?.roleName ?? '拖一位同事进来，或在右侧指派'}</small>
        </span>
        <GripVertical size={13} aria-hidden className="ent-node-grip" />
      </div>
      <p className={`ent-node-task${step.title.trim() ? '' : ' blank'}`}>
        {step.title.trim() || '还没有写工作内容'}
      </p>
      <span className="ent-node-foot">
        {problems.length ? (
          <span className="ent-node-warn">
            <AlertTriangle size={12} aria-hidden />
            {problems[0]}
          </span>
        ) : (
          <span className="ent-node-cap">{capability}</span>
        )}
        {step.needsConfirm ? <em>做完等我确认</em> : null}
      </span>

      <button type="button" className="ent-node-del" onClick={onRemove} aria-label="移除这个工作步骤">
        <X size={12} aria-hidden />
      </button>
      <button
        type="button"
        className="ent-node-port out"
        aria-label={`从「${step.title || '这一步'}」连到下一步`}
        onPointerDown={event => { event.stopPropagation(); onEdgeStart(); }}
      />
    </div>
  );
}

/** 节点最后一行的能力说明。员工自带技能 + 这一步单独加的技能包，最多列两个。 */
function capabilityLine(step: WorkDraftStep, employee: SiliconEmployee | undefined, skills: EmployeeSkill[]): string {
  const names = new Set<string>();
  for (const skill of skills) {
    if (employee && skill.employeeIds.includes(employee.id)) names.add(skill.name);
    if (step.skillIds.includes(skill.id)) names.add(skill.name);
  }
  for (const item of employee?.goodAt ?? []) names.add(item);
  const list = [...names].slice(0, 2);
  return list.length ? list.join(' · ') : '按工作内容自行判断';
}


