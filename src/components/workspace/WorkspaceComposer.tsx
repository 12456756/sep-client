import { ArrowUp, Bot, ChevronRight, FileText, FolderOpen, LoaderCircle, Paperclip, Plus, ShieldCheck, Sparkles, Wrench, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AvailableEmployee, AvailableSkill, AvailableWorkflow, ConversationDraft, LocalWorkspaceBinding, Task } from '../../features/workspace/useWorkspaceDemo';
import { WorkspaceEmployeeAvatar } from './WorkspaceEmployeeAvatar';

interface Props {
  compact?: boolean;
  mode: 'conversation' | 'workflow';
  busy?: boolean;
  draft: ConversationDraft;
  employees: AvailableEmployee[];
  skills: AvailableSkill[];
  workflows: AvailableWorkflow[];
  currentTask?: Task;
  activeEmployeeId?: string;
  onEmployeeChange?: (id: string) => void;
  onDraftChange: (patch: Partial<ConversationDraft>) => void;
  onConversationSubmit: (text: string) => void;
  onWorkflowSubmit: (draft: { workflowId: string; employeeId: string; workspace: LocalWorkspaceBinding; inputs: Record<string, string | number | boolean> }) => void;
}

type AddPanel = 'skills' | 'employees' | null;

export function WorkspaceComposer({ compact = false, mode, busy = false, draft, employees, skills, workflows, currentTask, activeEmployeeId, onEmployeeChange, onDraftChange, onConversationSubmit, onWorkflowSubmit }: Props) {
  const [text, setText] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [workflowInputs, setWorkflowInputs] = useState<Record<string, string | number | boolean>>({});
  const [workspace, setWorkspace] = useState<LocalWorkspaceBinding>(draft.workspace);
  const [employeeIds, setEmployeeIds] = useState<string[]>(() => {
    const initial = activeEmployeeId || draft.employeeId || currentTask?.employeeId;
    return initial ? [initial] : [];
  });
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addPanel, setAddPanel] = useState<AddPanel>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const selectedEmployeeId = activeEmployeeId || draft.employeeId || (currentTask && employeeIds.includes(currentTask.employeeId) ? currentTask.employeeId : '');
  const employee = employees.find(item => item.id === selectedEmployeeId);
  const workflow = workflows.find(item => item.id === workflowId);
  const selectedSkillIds = draft.skillIds;
  const workspaceLocked = Boolean(currentTask);
  const requiredInputsComplete = workflow?.inputs.every(input => !input.required || String(workflowInputs[input.id] ?? '').trim()) ?? false;
  const canSubmit = mode === 'conversation' ? Boolean(text.trim() && employee && !busy) : Boolean(workflow && requiredInputsComplete && !busy);
  const employeeSelection = selectedEmployeeId;

  useEffect(() => setWorkspace(draft.workspace), [draft.workspace.path, draft.workspace.displayName, draft.workspace.accessMode]);
  useEffect(() => {
    const initial = activeEmployeeId || draft.employeeId || currentTask?.employeeId;
    setEmployeeIds(initial ? [initial] : []);
  }, [currentTask?.id]);
  useEffect(() => {
    if (activeEmployeeId && !employeeIds.includes(activeEmployeeId)) setEmployeeIds(items => [...items, activeEmployeeId]);
  }, [activeEmployeeId, employeeIds]);
  useEffect(() => {
    if (!currentTask && draft.employeeId && !employeeIds.includes(draft.employeeId)) {
      setEmployeeIds(items => items.includes(draft.employeeId) ? items : [...items, draft.employeeId]);
    }
  }, [currentTask?.id, draft.employeeId, employeeIds]);
  useEffect(() => {
    if (!addMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) {
        setAddMenuOpen(false);
        setAddPanel(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAddMenuOpen(false);
        setAddPanel(null);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [addMenuOpen]);

  const updateWorkspace = (next: LocalWorkspaceBinding) => { setWorkspace(next); onDraftChange({ workspace: next }); };
  const chooseDirectory = async () => {
    if (workspaceLocked) return;
    const result = await window.electronAPI.selectDirectory();
    if (result.success && result.path) updateWorkspace({ path: result.path, displayName: result.path.split(/[\\/]/).filter(Boolean).pop() || result.path, accessMode: workspace.accessMode });
  };
  const handleFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = Array.from(event.target.files ?? []).map(file => file.name).filter(Boolean);
    if (next.length) setAttachments(items => Array.from(new Set([...items, ...next])));
    event.currentTarget.value = '';
    setAddMenuOpen(false);
    setAddPanel(null);
  };
  const addSkill = (id: string) => {
    if (!selectedSkillIds.includes(id)) onDraftChange({ skillIds: [...selectedSkillIds, id] });
  };
  const removeSkill = (id: string) => onDraftChange({ skillIds: selectedSkillIds.filter(item => item !== id) });
  const addEmployee = (id: string) => {
    const next = employees.find(item => item.id === id);
    if (!next) return;
    setEmployeeIds(items => items.includes(id) ? items : [...items, id]);
    onDraftChange({ employeeId: id, modelId: next.modelOptions[0]?.id || '' });
    onEmployeeChange?.(id);
    setAddMenuOpen(false);
    setAddPanel(null);
  };
  const removeEmployee = (id: string) => {
    const nextIds = employeeIds.filter(item => item !== id);
    setEmployeeIds(nextIds);
    if (id !== employeeSelection) return;
    const fallback = nextIds[0];
    if (fallback) {
      const next = employees.find(item => item.id === fallback);
      onDraftChange({ employeeId: fallback, modelId: next?.modelOptions[0]?.id || '' });
      onEmployeeChange?.(fallback);
    } else {
      onDraftChange({ employeeId: '', modelId: '' });
      onEmployeeChange?.('');
    }
  };
  const handleEmployeeChange = (id: string) => addEmployee(id);
  const submit = () => {
    if (!canSubmit) return;
    if (mode === 'conversation') { onConversationSubmit(text.trim()); setText(''); return; }
    if (workflow) onWorkflowSubmit({ workflowId: workflow.id, employeeId: workflow.employeeIds[0], workspace, inputs: workflowInputs });
  };

  return <section className={`workspace-composer ${compact ? 'compact' : ''} ${mode === 'workflow' ? 'workflow-mode' : ''}`} aria-label="工作输入">
    {mode === 'workflow' && <div className="workflow-fields"><label><span>工作方案</span><select value={workflowId} onChange={event => { setWorkflowId(event.target.value); setWorkflowInputs({}); }}><option value="">选择任务中心方案</option>{workflows.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{workflow?.inputs.map(input => <label key={input.id}><span>{input.label}{input.required ? ' *' : ''}</span>{input.type === 'long-text' ? <textarea className="workflow-input-textarea" value={String(workflowInputs[input.id] ?? '')} onChange={event => setWorkflowInputs({ ...workflowInputs, [input.id]: event.target.value })} placeholder={input.placeholder} /> : <input value={String(workflowInputs[input.id] ?? '')} onChange={event => setWorkflowInputs({ ...workflowInputs, [input.id]: event.target.value })} placeholder={input.placeholder} />}</label>)}</div>}
    {mode === 'conversation' && <div className="composer-employee-strip" aria-label="当前对话员工">
      {employeeIds.length === 0 ? <span className="composer-empty-chip">点击左下角 + 添加硅基员工</span> : employeeIds.map(id => {
        const item = employees.find(employeeItem => employeeItem.id === id);
        if (!item) return null;
        return <span className={`composer-employee-chip ${id === employeeSelection ? 'active' : ''}`} key={id}>
          <button type="button" className="composer-chip-remove" onClick={() => removeEmployee(id)} aria-label={`移除${item.displayName}`} title={`移除${item.displayName}`}><X size={12} /></button>
          <button type="button" className="composer-employee-chip-main" onClick={() => handleEmployeeChange(id)} title={`切换到${item.displayName}`}><WorkspaceEmployeeAvatar employee={item} /><span>{item.displayName}</span></button>
        </span>;
      })}
    </div>}
    {mode === 'conversation' && selectedSkillIds.length > 0 && <div className="composer-chip-strip" aria-label="已添加技能">{selectedSkillIds.map(id => { const skill = skills.find(item => item.id === id); if (!skill) return null; return <span className="composer-skill-chip" key={id}><button type="button" className="composer-chip-remove" onClick={() => removeSkill(id)} aria-label={`移除技能${skill.name}`} title={`移除技能${skill.name}`}><X size={12} /></button><Wrench size={13} /><span>{skill.name}</span></span>; })}</div>}
    {attachments.length > 0 && <div className="composer-chip-strip composer-attachment-strip" aria-label="已添加文件">{attachments.map(name => <span className="composer-file-chip" key={name}><FileText size={13} /><span title={name}>{name}</span><button type="button" className="composer-chip-remove" onClick={() => setAttachments(items => items.filter(item => item !== name))} aria-label={`移除文件${name}`} title={`移除文件${name}`}><X size={12} /></button></span>)}</div>}
    {mode === 'conversation' && <textarea value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder={employee ? `交代给${employee.displayName}的工作…` : '先添加一位硅基员工'} aria-label="对话消息" rows={compact ? 3 : 5} />}
    <div className="workspace-composer-footer"><div className="workspace-composer-tools">
      <div className="composer-add-wrap" ref={addMenuRef}>
        <button className="workspace-add-button" type="button" onClick={() => { setAddMenuOpen(value => !value); setAddPanel(null); }} aria-expanded={addMenuOpen} aria-label="添加内容" title="添加文件、技能或硅基员工"><span className={`composer-add-icon ${addMenuOpen ? 'is-hidden' : ''}`}><Plus size={20} /></span><span className={`composer-add-icon ${addMenuOpen ? '' : 'is-hidden'}`}><X size={19} /></span></button>
        {addMenuOpen && <div className="composer-add-menu" role="menu">
          <input ref={fileInputRef} className="composer-file-input" type="file" multiple aria-hidden="true" tabIndex={-1} onChange={handleFiles} />
          <button type="button" role="menuitem" onClick={() => fileInputRef.current?.click()} title="添加文件"><Paperclip size={15} /><span>添加文件</span></button>
          {mode === 'conversation' && <button type="button" role="menuitem" onMouseEnter={() => setAddPanel('skills')} onFocus={() => setAddPanel('skills')} onClick={() => setAddPanel(addPanel === 'skills' ? null : 'skills')} title="添加技能"><Wrench size={15} /><span>添加技能</span><ChevronRight size={14} className={addPanel === 'skills' ? 'rotate-90' : ''} /></button>}
          {mode === 'conversation' && <button type="button" role="menuitem" onMouseEnter={() => setAddPanel('employees')} onFocus={() => setAddPanel('employees')} onClick={() => setAddPanel(addPanel === 'employees' ? null : 'employees')} title="添加硅基员工"><Bot size={15} /><span>添加硅基员工</span><ChevronRight size={14} className={addPanel === 'employees' ? 'rotate-90' : ''} /></button>}
          {addPanel === 'skills' && <div className="composer-add-submenu composer-add-submenu-side">{skills.filter(skill => skill.installed).map(skill => <button type="button" key={skill.id} onClick={() => addSkill(skill.id)} disabled={selectedSkillIds.includes(skill.id)} title={selectedSkillIds.includes(skill.id) ? '已添加' : `添加${skill.name}`}><Wrench size={13} /><span>{skill.name}</span></button>)}</div>}
          {addPanel === 'employees' && <div className="composer-add-submenu composer-add-submenu-side">{employees.map(item => <button type="button" key={item.id} onClick={() => addEmployee(item.id)} className={employeeIds.includes(item.id) ? 'selected' : ''} title={`切换到${item.displayName}`}><WorkspaceEmployeeAvatar employee={item} /><span>{item.displayName}</span></button>)}</div>}
        </div>}
      </div>
      {mode === 'conversation' && <label className="composer-model-control"><Sparkles size={14} /><span>模型</span><select value={draft.modelId} disabled={!employee} onChange={event => onDraftChange({ modelId: event.target.value })} title="选择模型"><option value="">默认</option>{employee?.modelOptions.map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label>}
      {(mode === 'workflow' || mode === 'conversation') && <div className={`composer-workspace-group ${workspaceLocked ? 'locked' : ''}`} aria-label="工作目录设置"><button className="workspace-tool-button workspace-directory-button" type="button" onClick={() => void chooseDirectory()} disabled={workspaceLocked} title={workspaceLocked ? '已创建的对话不能修改工作目录' : (workspace.path || '选择工作目录')}><FolderOpen size={15} /><span>{workspace.displayName || '选择工作目录'}</span></button><label className="composer-permission-control"><ShieldCheck size={14} /><span>权限</span><select value={workspace.accessMode} onChange={event => updateWorkspace({ ...workspace, accessMode: event.target.value as LocalWorkspaceBinding['accessMode'] })} title="设置工作目录权限"><option value="read-write">读写</option><option value="read-only">只读</option></select></label></div>}
    </div><button className="workspace-submit" onClick={submit} disabled={!canSubmit} aria-label="安排工作" title={busy ? '正在安排工作' : '安排工作'}>{busy ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={17} />}</button></div>
  </section>;
}
