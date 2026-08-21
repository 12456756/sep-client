import { ArrowUp, LoaderCircle, SlidersHorizontal, Sparkles, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AvailableEmployee, AvailableSkill, AvailableWorkflow, ConversationDraft, LocalWorkspaceBinding, Task } from '../../features/workspace/useWorkspaceDemo';

interface Props {
  compact?: boolean;
  mode: 'conversation' | 'workflow';
  busy?: boolean;
  draft: ConversationDraft;
  employees: AvailableEmployee[];
  skills: AvailableSkill[];
  workflows: AvailableWorkflow[];
  currentTask?: Task;
  onDraftChange: (patch: Partial<ConversationDraft>) => void;
  onConversationSubmit: (text: string) => void;
  onWorkflowSubmit: (draft: { workflowId: string; employeeId: string; workspace: LocalWorkspaceBinding; inputs: Record<string, string | number | boolean> }) => void;
}

export function WorkspaceComposer({ compact = false, mode, busy = false, draft, employees, skills, workflows, currentTask, onDraftChange, onConversationSubmit, onWorkflowSubmit }: Props) {
  const [text, setText] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [workflowInputs, setWorkflowInputs] = useState<Record<string, string | number | boolean>>({});
  const [workspace, setWorkspace] = useState<LocalWorkspaceBinding>(draft.workspace);
  const [showOptions, setShowOptions] = useState(false);

  useEffect(() => {
    if (!currentTask) setShowOptions(mode === 'workflow');
  }, [mode, currentTask]);

  const employee = employees.find((item) => item.id === (currentTask?.employeeId ?? draft.employeeId));
  const workflow = workflows.find((item) => item.id === workflowId);
  const selectedSkillIds = currentTask?.skillIds ?? draft.skillIds;
  const requiredWorkflowInputsComplete = workflow?.inputs.every((input) => !input.required || String(workflowInputs[input.id] ?? '').trim()) ?? false;
  const canSubmit = mode === 'conversation'
    ? Boolean(text.trim() && employee && !busy)
    : Boolean(workflow && requiredWorkflowInputsComplete && (!workflow.requiresWorkspace || workspace.path) && !busy);
  const headerTitle = mode === 'workflow' ? workflow?.name ?? '选择工作流' : employee?.displayName ?? '选择硅基员工';
  const headerAvatar = mode === 'workflow' ? workflow?.name.slice(0, 1) ?? '流' : employee?.avatar ?? '员';

  const submit = () => {
    if (!canSubmit) return;
    if (mode === 'conversation') {
      onConversationSubmit(text.trim());
      setText('');
      return;
    }
    if (workflow) onWorkflowSubmit({ workflowId: workflow.id, employeeId: workflow.employeeIds[0], workspace, inputs: workflowInputs });
  };

  const updateWorkspace = (value: string) => {
    const next = { path: value, displayName: value ? value.split(/[\\/]/).filter(Boolean).pop() ?? value : '未选择工作空间', accessMode: 'read-write' as const };
    setWorkspace(next);
    onDraftChange({ workspace: next });
  };

  return (
    <section className={`workspace-composer ${compact ? 'compact' : ''} ${mode === 'workflow' ? 'workflow-mode' : ''}`} aria-label="任务输入区">
      {employee || workflow ? (
        <div className="workspace-composer-header">
          <div className="workspace-mode-label">
            <span className="workspace-avatar workspace-avatar-text">{headerAvatar}</span>
            <div>
              <small>{currentTask ? '当前任务' : mode === 'workflow' ? '新建工作流任务' : '新建对话任务'}</small>
              <strong>{headerTitle}</strong>
            </div>
          </div>
        </div>
      ) : null}

      {showOptions && mode === 'conversation' && !currentTask && (
        <div className="workspace-config-row">
          <label>
            <span>硅基员工</span>
            <select value={draft.employeeId} onChange={(event) => {
              const next = employees.find((item) => item.id === event.target.value);
              onDraftChange({ employeeId: event.target.value, modelId: next?.modelOptions[0]?.id ?? '' });
            }}>
              <option value="">选择员工</option>
              {employees.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
            </select>
          </label>
          <label>
            <span>模型</span>
            <select value={draft.modelId} disabled={!employee} onChange={(event) => onDraftChange({ modelId: event.target.value })}>
              <option value="">选择模型</option>
              {employee?.modelOptions.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
            </select>
          </label>
          <label>
            <span>工作空间</span>
            <input value={workspace.path} onChange={(event) => updateWorkspace(event.target.value)} placeholder="输入本机目录" />
          </label>
          <div className="workspace-skill-picker">
            <span>当前任务技能</span>
            {skills.map((skill) => <button key={skill.id} className={selectedSkillIds.includes(skill.id) ? 'selected' : ''} onClick={() => onDraftChange({ skillIds: selectedSkillIds.includes(skill.id) ? selectedSkillIds.filter((id) => id !== skill.id) : [...selectedSkillIds, skill.id] })}><Wrench size={13} />{skill.name}</button>)}
          </div>
        </div>
      )}

      {showOptions && mode === 'workflow' && !currentTask && (
        <div className="workflow-fields">
          <label>
            <span>工作流</span>
            <select value={workflowId} onChange={(event) => { setWorkflowId(event.target.value); setWorkflowInputs({}); }}>
              <option value="">选择已授权工作流</option>
              {workflows.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          {workflow?.inputs.map((input) => (
            <label key={input.id}>
              <span>{input.label}{input.required ? ' *' : ''}</span>
              {input.type === 'long-text' ? (
                <textarea className="workflow-input-textarea" value={String(workflowInputs[input.id] ?? '')} onChange={(event) => setWorkflowInputs({ ...workflowInputs, [input.id]: event.target.value })} placeholder={input.placeholder} />
              ) : input.type === 'enum' ? (
                <select value={String(workflowInputs[input.id] ?? '')} onChange={(event) => setWorkflowInputs({ ...workflowInputs, [input.id]: event.target.value })}>
                  <option value="">请选择</option>
                  {input.options?.map((option) => <option key={option}>{option}</option>)}
                </select>
              ) : (
                <input type={input.type === 'number' ? 'number' : 'text'} value={String(workflowInputs[input.id] ?? '')} onChange={(event) => setWorkflowInputs({ ...workflowInputs, [input.id]: input.type === 'number' ? Number(event.target.value) : event.target.value })} placeholder={input.placeholder} />
              )}
            </label>
          ))}
          {workflow && (
            <label>
              <span>工作空间</span>
              <input value={workspace.path} onChange={(event) => updateWorkspace(event.target.value)} placeholder={workflow.requiresWorkspace ? '输入本机目录（必填）' : '输入本机目录（可选）'} />
            </label>
          )}
        </div>
      )}

      {mode === 'conversation' && (
        <textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder={employee ? `向${employee.displayName}发送消息` : '请先选择硅基员工'} aria-label="对话消息" rows={compact ? 2 : 4} />
      )}

      <div className="workspace-composer-footer">
        <div className="workspace-composer-tools">
          {!currentTask && mode === 'conversation' && <button className="workspace-tool-button" onClick={() => setShowOptions((value) => !value)}><SlidersHorizontal size={14} />{showOptions ? '收起配置' : '任务配置'}</button>}
          {mode === 'conversation' && <span className="workspace-composer-divider" />}
          <div className="workspace-composer-hints"><Sparkles size={14} /><span>{mode === 'workflow' ? workflow?.description ?? '选择工作流后填写执行参数' : currentTask ? `${employee?.displayName} · ${draft.modelId}` : employee ? '发送首条消息后创建任务' : '选择硅基员工后开始任务'}</span></div>
        </div>
        <button className="workspace-submit" onClick={submit} disabled={!canSubmit} aria-label={mode === 'conversation' ? '发送消息并创建任务' : '创建工作流任务'}>{busy ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={17} />}</button>
      </div>
    </section>
  );
}
