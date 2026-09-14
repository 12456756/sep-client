/**
 * 自己编排。左边是安排方案，右边是当前那一步的配置，中间一条极浅的分割线。
 *
 * 刻意**不做**成 n8n / Dify 那种自由连线的画布：员工之间的关系就是先后顺序，
 * 上下拖一拖就能改。要表达的只有「谁先做、谁接着做」，一条竖着的链足够，
 * 多出来的自由度只会让用户面对一张空白画布不知道从哪开始。
 *
 * 顺序调整用 pointer 事件自己实现（HTML5 拖放的拖影和落点在这种卡片列表里对不准），
 * 但键盘一定要能用：把手上按 ↑ ↓ 就是上移下移。
 */

import { ArrowRight, BookmarkPlus, GripVertical, Plus, Settings2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { SiliconEmployee, WorkDraftStep } from '../../../features/enterprise/types';
import { createDraftStep, validateGraph } from '../../../features/enterprise/work-graph';
import { EmployeeFace } from '../EmployeeFace';

export interface ManualDraft {
  title: string;
  goal: string;
  steps: WorkDraftStep[];
  confirmedInputs: string[];
}

interface Props {
  employees: SiliconEmployee[];
  busy: boolean;
  /** 从「常用工作」「复制为新工作」或企业固定安排带进来的初始内容。 */
  seed: { title?: string; goal?: string; steps: WorkDraftStep[]; confirmedInputs?: string[] } | null;
  onOpenSettings: () => void;
  onSave: (draft: ManualDraft) => void;
  onStart: (draft: ManualDraft) => void;
}

/** 一条链：每一步都依赖上一步。加人、删人、换顺序之后都要重新串一遍。 */
function chain(steps: WorkDraftStep[]): WorkDraftStep[] {
  return steps.map((step, index) => ({ ...step, dependsOn: index ? [steps[index - 1]!.id] : [] }));
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

export function ManualArrange({ employees, busy, seed, onOpenSettings, onSave, onStart }: Props) {
  const [title, setTitle] = useState(seed?.title ?? '');
  const [goal, setGoal] = useState(seed?.goal ?? '');
  const [materials, setMaterials] = useState((seed?.confirmedInputs ?? []).join('\n'));
  const [steps, setSteps] = useState<WorkDraftStep[]>(() => chain(seed?.steps.map(step => ({ ...step })) ?? []));
  const [selectedId, setSelectedId] = useState<string | null>(seed?.steps[0]?.id ?? null);
  const [adding, setAdding] = useState(false);
  const [saved, setSaved] = useState(false);
  /** 正在拖的那一张：从第几个开始、跟着指针走了多远、一格多高、是否已经松手在归位。 */
  const [drag, setDrag] = useState<{ id: string; from: number; dy: number; rowH: number; settling: boolean } | null>(null);
  const list = useRef<HTMLUListElement>(null);

  const selected = steps.find(step => step.id === selectedId) ?? null;
  const problem = validateGraph(steps);
  const fallbackTitle = goal.trim().slice(0, 24) || '未命名工作';
  const confirmedInputs = materials.split('\n').map(line => line.trim()).filter(Boolean);
  const draft = (): ManualDraft => ({
    title: title.trim() || fallbackTitle,
    goal: goal.trim() || title.trim() || fallbackTitle,
    steps,
    confirmedInputs,
  });

  const replace = (next: WorkDraftStep[]) => { setSteps(chain(next)); setSaved(false); };

  const add = (employeeId: string) => {
    const step = createDraftStep(employeeId);
    replace([...steps, step]);
    setSelectedId(step.id);
    setAdding(false);
  };

  const patch = (id: string, change: Partial<WorkDraftStep>) => {
    setSteps(current => current.map(step => (step.id === id ? { ...step, ...change } : step)));
    setSaved(false);
  };

  const remove = (id: string) => {
    replace(steps.filter(step => step.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const reorder = (from: number, to: number) => {
    if (to < 0 || to >= steps.length) return;
    replace(move(steps, from, to));
  };

  /** 一格有多高：量前两张卡的间距，量不到（只有一张）就用卡高 + 连线的标称值。 */
  const rowHeight = (): number => {
    const items = list.current?.querySelectorAll<HTMLElement>('.ent-mn-item');
    if (items && items.length > 1) return items[1]!.offsetTop - items[0]!.offsetTop;
    return 132;
  };

  const startDrag = (event: React.PointerEvent, id: string, from: number) => {
    event.preventDefault();
    // 起点和格高在这一次拖动里是常量，闭包捕获比放 ref 稳 —— 松手时 ref 已经被清掉了。
    const startY = event.clientY;
    const rowH = rowHeight();
    const total = steps.length;
    setDrag({ id, from, dy: 0, rowH, settling: false });

    const slotOf = (clientY: number) => {
      const shift = Math.round((clientY - startY) / rowH);
      return Math.max(0, Math.min(total - 1, from + shift));
    };

    const onMove = (moved: PointerEvent) => {
      setDrag({ id, from, dy: moved.clientY - startY, rowH, settling: false });
    };
    const onUp = (up: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const to = slotOf(up.clientY);
      // 先滑到目标格，再真的换顺序 —— 直接换会瞬移，看不出吸附。
      setDrag({ id, from, dy: (to - from) * rowH, rowH, settling: true });
      window.setTimeout(() => { reorder(from, to); setDrag(null); }, 220);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /** 拖动中其他卡片让位：夹在起点和落点之间的整体上移或下移一格。 */
  const shiftOf = (index: number): number => {
    if (!drag) return 0;
    const to = Math.max(0, Math.min(steps.length - 1, drag.from + Math.round(drag.dy / drag.rowH)));
    if (index === drag.from) return 0;
    if (to > drag.from && index > drag.from && index <= to) return -drag.rowH;
    if (to < drag.from && index < drag.from && index >= to) return drag.rowH;
    return 0;
  };

  return (
    <section className="ent-arr-manual">

      <div className="ent-mn">
        <div className="ent-mn-plan">
          <input
            className="ent-mn-goal"
            value={goal}
            placeholder="一句话说明这项工作要完成什么"
            aria-label="工作目标"
            onChange={event => { setGoal(event.target.value); setSaved(false); }}
          />

          {steps.length ? (
            <ul className={`ent-mn-list${drag ? ' busy' : ''}`} ref={list}>
              {steps.map((step, index) => {
                const employee = employees.find(item => item.id === step.employeeId);
                const isDragged = drag?.id === step.id;
                const offset = isDragged ? drag!.dy : shiftOf(index);
                return (
                  <li
                    key={step.id}
                    className={`ent-mn-item${isDragged ? ' dragging' : ''}${drag && !isDragged ? ' faded' : ''}`}
                    style={{
                      transform: offset ? `translateY(${offset}px)` : undefined,
                      transition: drag && (!isDragged || drag.settling) ? 'transform 220ms cubic-bezier(.22,1,.36,1)' : undefined,
                    }}
                  >
                    <button
                      type="button"
                      className={`ent-mn-node${selectedId === step.id ? ' on' : ''}`}
                      onClick={() => setSelectedId(step.id)}
                      aria-pressed={selectedId === step.id}
                    >
                      <span className="ent-mn-no" aria-hidden>{String(index + 1).padStart(2, '0')}</span>
                      <EmployeeFace seed={step.employeeId || 'sep'} size="md" round />
                      <span className="ent-mn-id">
                        <strong>{employee?.name ?? '还没有指定员工'}</strong>
                        <small>{employee?.roleName ?? '点这里选一位同事'}</small>
                        <em className={step.title.trim() ? undefined : 'blank'}>
                          {step.title.trim() || '还没有写这一步做什么'}
                        </em>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ent-mn-grip"
                      onPointerDown={event => startDrag(event, step.id, index)}
                      onKeyDown={event => {
                        if (event.key === 'ArrowUp') { event.preventDefault(); reorder(index, index - 1); }
                        if (event.key === 'ArrowDown') { event.preventDefault(); reorder(index, index + 1); }
                      }}
                      aria-label={`调整第 ${index + 1} 步的顺序，上下方向键可以移动`}
                    >
                      <GripVertical size={14} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="ent-mn-del"
                      onClick={() => remove(step.id)}
                      aria-label={`删除第 ${index + 1} 步`}
                    >
                      <X size={12} aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="ent-mn-blank">还没有员工。点下面的「添加员工」，选中的人会按先后顺序接着做。</p>
          )}

          <div className="ent-mn-add">
            <button type="button" className="ent-mn-addbtn" onClick={() => setAdding(open => !open)} aria-expanded={adding}>
              <Plus size={14} aria-hidden />
              添加员工
            </button>
            {adding ? (
              <ul className="ent-mn-pick">
                {employees.map(employee => (
                  <li key={employee.id}>
                    <button type="button" onClick={() => add(employee.id)}>
                      <EmployeeFace seed={employee.id} size="sm" round />
                      <span>
                        <strong>{employee.name}</strong>
                        <small>{employee.roleName}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        <aside className="ent-mn-side" aria-label={selected ? '当前步骤的配置' : '这项工作'}>
          {selected ? (
            <StepForm
              step={selected}
              employees={employees}
              order={steps.findIndex(item => item.id === selected.id) + 1}
              onPatch={change => patch(selected.id, change)}
            />
          ) : (
            <>
              <h2>这项工作</h2>
              <p className="ent-mn-side-hint">点左边任意一位员工，这里就变成他那一步的配置。</p>
              <label className="ent-mn-field">
                <span>工作名称</span>
                <input
                  className="ent-mn-input"
                  value={title}
                  placeholder={fallbackTitle}
                  onChange={event => { setTitle(event.target.value); setSaved(false); }}
                />
              </label>
              <label className="ent-mn-field">
                <span>你已经准备好的资料</span>
                <textarea
                  className="ent-mn-input tall"
                  value={materials}
                  placeholder={'一行写一项，例如：\n客户资料在「客户/2026」文件夹\n上季度周报可以作为格式参考'}
                  onChange={event => { setMaterials(event.target.value); setSaved(false); }}
                />
                <small>写在这里的内容表示你确认可以交给员工使用，参与这项工作的每一位同事都能看到。</small>
              </label>
            </>
          )}
        </aside>
      </div>

      <footer className="ent-arr-foot">
        <button
          type="button"
          className="ent-arr-second"
          disabled={!steps.length || saved}
          onClick={() => { onSave(draft()); setSaved(true); }}
        >
          <BookmarkPlus size={14} aria-hidden />
          {saved ? '已存为常用' : '保存为常用'}
        </button>
        <span className="ent-arr-gap" />
        {problem ? <span className="ent-arr-problem">{problem}</span> : null}
        <button type="button" className="ent-arr-ghost" onClick={onOpenSettings}>
          <Settings2 size={14} aria-hidden />
          执行设置
        </button>
        <button
          type="button"
          className="ent-arr-primary"
          disabled={busy || Boolean(problem)}
          title={problem ?? undefined}
          onClick={() => onStart(draft())}
        >
          {busy ? '正在安排…' : '开始工作'}
          <ArrowRight size={15} aria-hidden />
        </button>
      </footer>
    </section>
  );
}

/** 右栏：当前这一步做什么。字段顺序按用户的思考顺序排，不按数据结构排。 */
function StepForm({ step, employees, order, onPatch }: {
  step: WorkDraftStep;
  employees: SiliconEmployee[];
  order: number;
  onPatch: (change: Partial<WorkDraftStep>) => void;
}) {
  const employee = employees.find(item => item.id === step.employeeId);
  return (
    <>
      <header className="ent-mn-side-head">
        <EmployeeFace seed={step.employeeId || 'sep'} size="md" round />
        <span>
          <strong>{employee?.name ?? '还没有指定员工'}</strong>
          <small>{employee?.roleName ?? '在下面选一位同事'}</small>
        </span>
        <em>第 {order} 步</em>
      </header>

      <label className="ent-mn-field">
        <span>工作</span>
        <textarea
          className="ent-mn-input tall"
          value={step.title}
          placeholder="例如：整理 618 活动的销售数据"
          onChange={event => onPatch({ title: event.target.value })}
        />
        <small>写清「要完成什么」，员工按这句话干活。</small>
      </label>

      <div className="ent-mn-pair">
        <label className="ent-mn-field">
          <span>输入</span>
          <input
            className="ent-mn-input"
            value={step.input}
            placeholder="留空表示用上一步的结果"
            onChange={event => onPatch({ input: event.target.value })}
          />
        </label>
        <label className="ent-mn-field">
          <span>输出</span>
          <input
            className="ent-mn-input"
            value={step.output}
            placeholder="例如：一份销售数据汇总表"
            onChange={event => onPatch({ output: event.target.value })}
          />
        </label>
      </div>

      <label className="ent-mn-field">
        <span>负责人</span>
        <select className="ent-mn-input" value={step.employeeId} onChange={event => onPatch({ employeeId: event.target.value })}>
          <option value="">还没有指定</option>
          {employees.map(item => <option key={item.id} value={item.id}>{item.name}（{item.roleName}）</option>)}
        </select>
      </label>

      <label className="ent-mn-check">
        <input type="checkbox" checked={step.needsConfirm} onChange={event => onPatch({ needsConfirm: event.target.checked })} />
        <span>这一步完成后先等我确认，再往下走</span>
      </label>
    </>
  );
}


