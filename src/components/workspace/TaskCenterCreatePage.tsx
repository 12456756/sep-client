import { ArrowLeft, Bot, ChevronRight, FolderOpen, Link2, Plus, Sparkles, Trash2, UserRound, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { AvailableEmployee, AvailableWorkflow, DagNodeDraft, LocalWorkspaceBinding, WorkflowDraft } from '../../features/workspace/useWorkspaceDemo';

interface Props {
  employees: AvailableEmployee[];
  workflows: AvailableWorkflow[];
  initialWorkflowId?: string;
  onBack: () => void;
  onSubmit: (draft: WorkflowDraft) => void;
}

type CreateMode = 'auto' | 'manual';
const makeId = () => `node-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const defaultWorkspace: LocalWorkspaceBinding = { path: '', displayName: '未选择工作目录', accessMode: 'read-write' };

function makeAutoNodes(goal: string, employees: AvailableEmployee[]): DagNodeDraft[] {
  const roles = ['拆解目标与整理输入', '完成核心工作并形成中间成果', '复核结果并准备最终交付'];
  return employees.slice(0, Math.min(3, employees.length)).map((employee, index) => ({
    id: `auto-${index + 1}`,
    employeeInstanceId: employee.id,
    title: roles[index],
    instruction: index === 0 ? `理解“${goal}”，整理执行输入、约束和检查项。` : index === 1 ? `根据前一步成果完成“${goal}”的核心工作。` : `复核前序成果，整理“${goal}”的最终交付。`,
    expectedOutput: index === 0 ? '执行清单与输入摘要' : index === 1 ? '可供复核的阶段成果' : '最终交付说明与成果文件',
    dependsOn: index ? [`auto-${index}`] : [],
    x: 80 + index * 280,
    y: 110,
  }));
}

export function TaskCenterCreatePage({ employees, workflows, initialWorkflowId, onBack, onSubmit }: Props) {
  const initialWorkflow = workflows.find(item => item.id === initialWorkflowId);
  const [mode, setMode] = useState<CreateMode>('auto');
  const [goal, setGoal] = useState(initialWorkflow?.description ?? '');
  const [workspace, setWorkspace] = useState(defaultWorkspace);
  const [nodes, setNodes] = useState<DagNodeDraft[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [draggedEmployeeId, setDraggedEmployeeId] = useState<string | null>(null);
  const [movingNode, setMovingNode] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const employeeById = useMemo(() => new Map(employees.map(item => [item.id, item])), [employees]);
  const selectedNode = nodes.find(node => node.id === selectedNodeId);
  const canSubmit = Boolean(goal.trim() && employees.length && (mode === 'auto' || nodes.length));

  const chooseDirectory = async () => {
    const result = await window.electronAPI.selectDirectory();
    if (result.success && result.path) setWorkspace(current => ({ ...current, path: result.path!, displayName: result.path!.split(/[\\/]/).filter(Boolean).pop() || result.path! }));
  };
  const updateNode = (id: string, patch: Partial<DagNodeDraft>) => setNodes(items => items.map(node => node.id === id ? { ...node, ...patch } : node));
  const dependsOnNode = (nodeId: string, dependencyId: string): boolean => {
    const dependency = nodes.find(node => node.id === dependencyId);
    return dependency?.dependsOn.some(id => id === nodeId || dependsOnNode(nodeId, id)) ?? false;
  };
  const toggleDependency = (nodeId: string, dependencyId: string) => {
    if (nodeId === dependencyId || dependsOnNode(nodeId, dependencyId)) return;
    const node = nodes.find(item => item.id === nodeId);
    if (!node) return;
    updateNode(nodeId, { dependsOn: node.dependsOn.includes(dependencyId) ? node.dependsOn.filter(id => id !== dependencyId) : [...node.dependsOn, dependencyId] });
  };
  const addEmployeeNode = (employeeId: string, point?: { x: number; y: number }) => {
    const employee = employeeById.get(employeeId); if (!employee) return;
    const id = makeId(); const previous = nodes[nodes.length - 1];
    setNodes(items => [...items, { id, employeeInstanceId: employee.id, title: `${employee.displayName}的工作`, instruction: `请围绕“${goal.trim() || '用户目标'}”完成你的职责。`, expectedOutput: '阶段工作成果', dependsOn: previous ? [previous.id] : [], x: point?.x ?? 80 + (items.length % 3) * 280, y: point?.y ?? 100 + Math.floor(items.length / 3) * 190 }]);
    setSelectedNodeId(id);
  };
  const removeNode = (id: string) => { setNodes(items => items.filter(node => node.id !== id).map(node => ({ ...node, dependsOn: node.dependsOn.filter(dep => dep !== id) }))); if (selectedNodeId === id) setSelectedNodeId(null); };
  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault(); if (!draggedEmployeeId || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    addEmployeeNode(draggedEmployeeId, { x: Math.max(20, event.clientX - rect.left - 110), y: Math.max(20, event.clientY - rect.top - 55) });
    setDraggedEmployeeId(null);
  };
  const moveNode = (event: React.PointerEvent<HTMLElement>, node: DagNodeDraft) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    setMovingNode({ id: node.id, offsetX: event.clientX - rect.left - (node.x ?? 0), offsetY: event.clientY - rect.top - (node.y ?? 0) });
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedNodeId(node.id);
  };
  const updateNodePosition = (event: React.PointerEvent<HTMLElement>) => {
    if (!movingNode || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    updateNode(movingNode.id, { x: Math.max(18, event.clientX - rect.left - movingNode.offsetX), y: Math.max(18, event.clientY - rect.top - movingNode.offsetY) });
  };
  const stopMovingNode = (event: React.PointerEvent<HTMLElement>) => {
    if (movingNode && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setMovingNode(null);
  };
  const submit = () => {
    if (!canSubmit) return;
    const generated = mode === 'auto' ? makeAutoNodes(goal.trim(), employees) : nodes;
    const first = generated[0];
    if (!first) return;
    onSubmit({ workflowId: initialWorkflow?.id || 'auto-dag', employeeId: first.employeeInstanceId, workspace, goal: goal.trim(), steps: generated, nodes: generated, mode, inputs: { goal: goal.trim(), accessMode: workspace.accessMode } });
  };

  return <section className="task-plan-create task-dag-create">
    <header className="task-plan-create-header"><button className="task-plan-back" type="button" onClick={onBack}><ArrowLeft size={16} />任务中心</button><div className="task-dag-title"><span className="eyebrow"><Sparkles size={14} />安排一组员工</span><strong>把目标交代清楚，员工会按 DAG 协作完成</strong></div></header>
    <div className="task-dag-intro"><div><h1>你希望完成什么工作？</h1><p>先选择工作方式，再确认员工、依赖关系和交付结果。</p></div><div className="task-dag-mode-switch" role="tablist" aria-label="创建方式"><button type="button" className={mode === 'auto' ? 'active' : ''} onClick={() => setMode('auto')} role="tab" aria-selected={mode === 'auto'}><Sparkles size={15} /><span><strong>自动编排</strong><small>输入目标，由系统安排员工</small></span></button><button type="button" className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')} role="tab" aria-selected={mode === 'manual'}><Link2 size={15} /><span><strong>员工编排</strong><small>拖动员工，自定义工作流</small></span></button></div></div>
    <label className="task-dag-goal"><span>工作目标</span><textarea value={goal} onChange={event => setGoal(event.target.value)} rows={4} placeholder="例如：整理本季度销售数据，并生成管理层分析报告" autoFocus /></label>
    <div className="task-dag-workspace-row"><div><span>工作目录</span><button type="button" onClick={() => void chooseDirectory()} title="选择工作目录"><FolderOpen size={15} /><strong>{workspace.displayName}</strong></button></div><label><span>权限</span><select value={workspace.accessMode} onChange={event => setWorkspace(current => ({ ...current, accessMode: event.target.value as LocalWorkspaceBinding['accessMode'] }))}><option value="read-write">可修改文件</option><option value="read-only">只读</option></select></label></div>
    {mode === 'auto' ? <section className="task-auto-preview"><div className="task-auto-preview-heading"><div><span className="eyebrow"><Bot size={14} />系统将为你安排员工</span><h2>目标确认后生成协作图</h2></div><span>{employees.length} 位可用员工</span></div><div className="task-auto-employee-strip">{employees.slice(0, 5).map(employee => <span key={employee.id}><span className="workspace-avatar workspace-avatar-text">{employee.avatar || <UserRound size={14} />}</span>{employee.displayName}</span>)}</div><p>系统会根据员工的职责和可用模型生成起始节点；需要调整员工或顺序时，可切换到“员工编排”。</p></section> : <section className="task-dag-editor"><aside className="task-dag-palette"><div className="task-dag-panel-heading"><strong>可用员工</strong><small>拖到画布添加节点</small></div><div className="task-dag-employee-list">{employees.map(employee => <button key={employee.id} type="button" draggable onDragStart={() => setDraggedEmployeeId(employee.id)} onClick={() => addEmployeeNode(employee.id)} title="拖动或点击添加"><span className="workspace-avatar workspace-avatar-text">{employee.avatar || <UserRound size={14} />}</span><span><strong>{employee.displayName}</strong><small>{employee.description}</small></span><Plus size={14} /></button>)}</div></aside><div className="task-dag-canvas" ref={canvasRef} onDragOver={event => event.preventDefault()} onDrop={handleDrop} onClick={() => setSelectedNodeId(null)} onPointerMove={updateNodePosition} onPointerUp={stopMovingNode} onPointerCancel={stopMovingNode}><div className="task-dag-canvas-grid" aria-hidden="true" />{nodes.length > 1 && <svg className="task-dag-links" aria-hidden="true"><defs><marker id="task-dag-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" /></marker></defs>{nodes.flatMap(node => node.dependsOn.map(dependency => { const source = nodes.find(item => item.id === dependency); if (!source) return null; return <line key={`${dependency}-${node.id}`} x1={(source.x ?? 0) + 220} y1={(source.y ?? 0) + 56} x2={node.x ?? 0} y2={(node.y ?? 0) + 56} />; }))}</svg>}{nodes.length === 0 && <div className="task-dag-canvas-empty"><Link2 size={22} /><strong>拖动员工到这里</strong><span>也可以点击左侧员工添加第一个节点</span></div>}{nodes.map((node, index) => { const employee = employeeById.get(node.employeeInstanceId); return <article key={node.id} className={`task-dag-node ${selectedNodeId === node.id ? 'selected' : ''}`} style={{ left: node.x, top: node.y }} onPointerDown={event => moveNode(event, node)} onClick={event => { event.stopPropagation(); setSelectedNodeId(node.id); }}><header><span className="task-dag-node-index">{index + 1}</span><span className="workspace-avatar workspace-avatar-text">{employee?.avatar || <UserRound size={14} />}</span><div><strong>{employee?.displayName || '未选择员工'}</strong><small>{node.title}</small></div><button type="button" onPointerDown={event => event.stopPropagation()} onClick={() => removeNode(node.id)} aria-label="删除节点" title="删除节点"><Trash2 size={13} /></button></header><p>{node.instruction}</p>{node.dependsOn.length > 0 && <footer><ChevronRight size={13} />接收前置节点成果</footer>}</article>; })}</div>{selectedNode && <aside className="task-dag-node-inspector"><div className="task-dag-panel-heading"><strong>节点设置</strong><button type="button" onClick={() => setSelectedNodeId(null)} aria-label="关闭节点设置"><X size={15} /></button></div><label><span>执行员工</span><select value={selectedNode.employeeInstanceId} onChange={event => updateNode(selectedNode.id, { employeeInstanceId: event.target.value })}>{employees.map(employee => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label><label><span>节点名称</span><input value={selectedNode.title} onChange={event => updateNode(selectedNode.id, { title: event.target.value })} /></label><label><span>交代工作</span><textarea rows={5} value={selectedNode.instruction} onChange={event => updateNode(selectedNode.id, { instruction: event.target.value })} /></label><label><span>预期输出</span><textarea rows={3} value={selectedNode.expectedOutput} onChange={event => updateNode(selectedNode.id, { expectedOutput: event.target.value })} /></label><div className="task-dag-dependencies"><span>依赖节点</span><div>{nodes.filter(node => node.id !== selectedNode.id).map(node => <button key={node.id} type="button" disabled={dependsOnNode(selectedNode.id, node.id)} className={selectedNode.dependsOn.includes(node.id) ? 'active' : ''} onClick={() => toggleDependency(selectedNode.id, node.id)}>{nodes.indexOf(node) + 1}. {node.title || '未命名节点'}</button>)}</div></div></aside>}</section>}
    <footer className="task-dag-actions"><span>{mode === 'auto' ? '确认后会生成 DAG 并进入执行详情' : `${nodes.length} 个节点 · 可继续调整依赖和员工`}</span><button className="workspace-primary-button" type="button" disabled={!canSubmit} onClick={submit}>{mode === 'auto' ? '生成并开始安排' : '保存编排并开始'}<ChevronRight size={16} /></button></footer>
  </section>;
}
