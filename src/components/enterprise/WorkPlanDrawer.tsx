/**
 * 「改一版安排」抽屉：同一批同事、同样的先后顺序，只改要完成什么。
 *
 * 刻意不跳去「安排工作」那一页 —— 到了那里你面对的是一次重新选人和一张画布，
 * 而这里要做的事只有一件：换个说法再做一遍。真要换人或者增删步骤，
 * 底下留了一个去完整安排页的入口。
 *
 * 提交是「开一项新工作」，不是「改掉这一项」：正在跑的工作没法中途换目标，
 * 已经做完的工作也不该被后来的改动盖掉历史。所以这句话写在抽屉最上面，
 * 不让用户以为自己在编辑眼前那一项。
 */

import { PencilLine, Users, X } from 'lucide-react';
import { useState } from 'react';
import type { WorkItem } from '../../features/enterprise/types';
import { useDrawer } from '../../features/enterprise/use-drawer';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import { EmployeeFace } from './EmployeeFace';

interface Props {
  work: WorkItem;
  workspace: EnterpriseWorkspace;
  onClose: () => void;
}

/**
 * 一步里可改的内容。由谁来做、依赖哪几步、做完要不要你确认都原样带走，
 * 不出现在表单里 —— 它们是「怎么安排」，这张表单只问「要完成什么」。
 */
interface Row {
  id: string;
  employeeId: string;
  employeeName: string;
  title: string;
  output: string;
}

export function WorkPlanDrawer({ work, workspace, onClose }: Props) {
  const panel = useDrawer(onClose);
  const [title, setTitle] = useState(work.title);
  const [goal, setGoal] = useState(work.goal);
  const [rows, setRows] = useState<Row[]>(() => seed(work));

  const available = new Set(workspace.myEmployees.map(item => item.id));
  const missing = rows.filter(row => !available.has(row.employeeId));
  const ready = Boolean(goal.trim()) && rows.every(row => row.title.trim()) && !missing.length;

  const patch = (index: number, next: Partial<Row>) => {
    setRows(current => current.map((row, at) => (at === index ? { ...row, ...next } : row)));
  };

  const submit = () => {
    // 不在这里关抽屉：成功时 arrangeWork 会跳到新工作，这一页连着抽屉一起卸掉；
    // 失败时抽屉留在原地，用户刚改的内容不会丢。
    void workspace.arrangeWork({
      title: title.trim() || work.title,
      goal: goal.trim(),
      workDir: work.workDir ?? '',
      confirmedInputs: work.sharedContext.confirmedInputs,
      sharedSkillIds: [],
      steps: rows.map(row => {
        const before = work.steps.find(step => step.id === row.id);
        return {
          id: row.id,
          employeeId: row.employeeId,
          title: row.title.trim(),
          input: before?.input ?? '',
          output: row.output.trim(),
          dependsOn: before ? [...before.dependsOn] : [],
          needsConfirm: before?.needsConfirm ?? false,
          skillIds: [],
          x: 0,
          y: 0,
        };
      }),
    });
  };

  return (
    <>
      <div className="ent-drawer-back" role="presentation" onMouseDown={onClose} />
      <aside className="ent-drawer wide" role="dialog" aria-modal="true" aria-labelledby="ent-plan-title" ref={panel}>
        <header className="ent-drawer-head">
          <div className="ent-drawer-id">
            <h2 id="ent-plan-title">改一版安排</h2>
            <small title={work.title}>基于「{work.title}」</small>
          </div>
          <button type="button" className="ent-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={15} aria-hidden />
          </button>
        </header>

        <div className="ent-drawer-body">
          <p className="ent-drawer-lead">
            <Users size={14} aria-hidden />
            <span>
              员工和先后顺序保持原样，你只改要完成什么。提交后按新的说明<strong>开一项新工作</strong>，当前这一项不受影响。
            </span>
          </p>

          <label className="ent-field">
            <span>工作名称</span>
            <input className="ent-input" value={title} placeholder={work.title} onChange={event => setTitle(event.target.value)} />
          </label>

          <label className="ent-field">
            <span>要完成什么</span>
            <textarea className="ent-textarea" value={goal} placeholder="一句话说清这次要做成什么" onChange={event => setGoal(event.target.value)} />
          </label>

          <h3 className="ent-plan-h">每一步要完成什么 <em>（{rows.length} 步）</em></h3>
          <ol className="ent-plan-steps">
            {rows.map((row, index) => (
              <li key={row.id} className="ent-plan-step">
                <span className="ent-plan-who">
                  <b>{index + 1}</b>
                  <EmployeeFace employee={workspace.employees.find(item => item.id === row.employeeId)} name={row.employeeName} size="sm" round />
                  <strong title={row.employeeName}>{row.employeeName}</strong>
                  {available.has(row.employeeId) ? null : <em>已不可用</em>}
                </span>
                <label className="ent-field">
                  <span>完成什么</span>
                  <input className="ent-input" value={row.title} onChange={event => patch(index, { title: event.target.value })} />
                </label>
                <label className="ent-field">
                  <span>产出什么</span>
                  <input className="ent-input" value={row.output} placeholder="例如：一份可交付的报告" onChange={event => patch(index, { output: event.target.value })} />
                </label>
              </li>
            ))}
          </ol>

          {missing.length ? (
            <p className="ent-hint">
              有 {missing.length} 位同事已经不归你使用，这一版没法直接开工。
              到完整的安排页重新指派，或者把这几步交给其他同事。
            </p>
          ) : null}
        </div>

        <div className="ent-drawer-foot">
          <button type="button" className="ent-btn ghost sm" onClick={() => workspace.duplicateWork(work.id)}>
            换人或增删步骤
          </button>
          <span className="ent-ask-spacer" />
          <button type="button" className="ent-btn sm" onClick={onClose}>取消</button>
          <button type="button" className="ent-btn primary sm" onClick={submit} disabled={!ready || workspace.busy}>
            <PencilLine size={13} aria-hidden />
            按这一版重新安排
          </button>
        </div>
      </aside>
    </>
  );
}

/**
 * 表单初值。旧版流程工作（[SEP_WORKFLOW_TASK]）没有留下步骤明细，
 * 这时按「一位员工一个步骤」给一行 —— 否则表单是空的，也没法提交。
 */
function seed(work: WorkItem): Row[] {
  if (work.steps.length) {
    return work.steps.map(step => ({
      id: step.id,
      employeeId: step.employeeId,
      employeeName: step.employeeName,
      title: step.title,
      output: step.output,
    }));
  }
  return [{
    id: `step-${Date.now().toString(36)}`,
    employeeId: work.currentEmployeeId,
    employeeName: work.currentEmployeeName,
    title: work.title,
    output: '',
  }];
}
