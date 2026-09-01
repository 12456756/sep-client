/**
 * 纵向工作步骤编辑器。刻意不使用画布与连线：
 * 步骤是从上到下的一串事情，用户只需要回答四件事 ——
 * 由谁完成、完成什么、需要什么、产出什么。
 */

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { ArrangeWorkDraft } from '../../features/enterprise/useEnterpriseWorkspace';
import type { SiliconEmployee } from '../../features/enterprise/types';
import { EmployeeAvatar } from './atoms';

type DraftStep = ArrangeWorkDraft['steps'][number];

interface Props {
  steps: DraftStep[];
  employees: SiliconEmployee[];
  onChange: (steps: DraftStep[]) => void;
  /** 固定流程里步骤内容由企业定义，用户只调整参与员工与确认点。 */
  lockContent?: boolean;
}

export function createStep(employeeId: string, index: number): DraftStep {
  return {
    id: `step-${Date.now()}-${index}`,
    employeeId,
    title: '',
    input: '',
    output: '',
    inheritPrevious: index > 0,
    needsConfirm: false,
  };
}

export function StepEditor({ steps, employees, onChange, lockContent = false }: Props) {
  const patch = (index: number, next: Partial<DraftStep>) => onChange(steps.map((step, position) => (position === index ? { ...step, ...next } : step)));

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next.map((step, position) => ({ ...step, inheritPrevious: position === 0 ? false : step.inheritPrevious })));
  };

  return (
    <div className="ent-steps">
      {steps.map((step, index) => {
        const employee = employees.find(item => item.id === step.employeeId);
        return (
          <div key={step.id} className="ent-step">
            <div className="ent-step-rail">
              <span className="ent-step-no">{index + 1}</span>
              {index < steps.length - 1 ? <span className="ent-step-line" aria-hidden /> : null}
            </div>
            <div className="ent-step-body">
              <div className="ent-step-row">
                <label className="ent-field grow">
                  <span>由谁完成</span>
                  <span className="ent-step-owner">
                    <EmployeeAvatar mark={employee?.mark ?? '员'} size="sm" />
                    <select className="ent-select" value={step.employeeId} onChange={event => patch(index, { employeeId: event.target.value })}>
                      {employees.map(item => <option key={item.id} value={item.id}>{item.name}（{item.roleName}）</option>)}
                    </select>
                  </span>
                </label>
                <div className="ent-step-tools">
                  <button type="button" className="ent-icon-btn" onClick={() => move(index, -1)} disabled={index === 0} aria-label="上移这一步"><ArrowUp size={14} aria-hidden /></button>
                  <button type="button" className="ent-icon-btn" onClick={() => move(index, 1)} disabled={index === steps.length - 1} aria-label="下移这一步"><ArrowDown size={14} aria-hidden /></button>
                  <button type="button" className="ent-icon-btn danger" onClick={() => onChange(steps.filter((_, position) => position !== index))} disabled={steps.length === 1} aria-label="删除这一步"><Trash2 size={14} aria-hidden /></button>
                </div>
              </div>
              <label className="ent-field">
                <span>完成什么</span>
                <input className="ent-input" value={step.title} readOnly={lockContent} placeholder="例如：整理客户往来记录" onChange={event => patch(index, { title: event.target.value })} />
              </label>
              <div className="ent-step-row">
                <label className="ent-field grow">
                  <span>需要什么</span>
                  <input className="ent-input" value={step.input} readOnly={lockContent} placeholder="例如：客户资料文件夹" onChange={event => patch(index, { input: event.target.value })} />
                </label>
                <label className="ent-field grow">
                  <span>产出什么</span>
                  <input className="ent-input" value={step.output} readOnly={lockContent} placeholder="例如：按客户归类的沟通记录" onChange={event => patch(index, { output: event.target.value })} />
                </label>
              </div>
              <div className="ent-step-flags">
                <label>
                  <input type="checkbox" checked={index > 0 && step.inheritPrevious} disabled={index === 0} onChange={event => patch(index, { inheritPrevious: event.target.checked })} />
                  把上一步的结果交给这一步
                </label>
                <label>
                  <input type="checkbox" checked={step.needsConfirm} onChange={event => patch(index, { needsConfirm: event.target.checked })} />
                  这一步完成后先让我确认
                </label>
              </div>
            </div>
          </div>
        );
      })}
      <button type="button" className="ent-step-add" onClick={() => onChange([...steps, createStep(employees[0]?.id ?? '', steps.length)])}>
        <Plus size={14} aria-hidden />
        再加一个步骤
      </button>
    </div>
  );
}
