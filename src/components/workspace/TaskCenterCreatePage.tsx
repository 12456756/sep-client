import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, Bot, ChevronRight, FolderOpen, Link2, Plus, Sparkles, Trash2, UserRound } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { AvailableEmployee, AvailableWorkflow, DagNodeDraft, LocalWorkspaceBinding, WorkflowDraft } from '../../features/workspace/useWorkspaceDemo';

interface Props {
  employees: AvailableEmployee[];
  workflows: AvailableWorkflow[];
  initialWorkflowId?: string;
  onBack: () => void;
  onSubmit: (draft: WorkflowDraft) => void;
}

interface EmployeeNodeData extends Record<string, unknown> {
  index: number;
  employeeName: string;
  avatar: string;
  title: string;
  instruction: string;
  dependencyCount: number;
  onRemove: (id: string) => void;
}

type EmployeeFlowNode = Node<EmployeeNodeData, 'employee'>;
type CreateMode = 'auto' | 'manual';

const nodeTypes = { employee: EmployeeNode };
const makeId = () => `node-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const defaultWorkspace: LocalWorkspaceBinding = { path: '', displayName: '未选择工作目录', accessMode: 'read-write' };

function EmployeeNode({ id, data, selected }: NodeProps<EmployeeFlowNode>) {
  return <article className={`task-dag-node ${selected ? 'selected' : ''}`}>
    <Handle className="task-dag-handle task-dag-handle-target" type="target" position={Position.Left} title="连接前置节点" />
    <header>
      <span className="task-dag-node-index">{data.index}</span>
      <span className="workspace-avatar">{data.avatar || <UserRound size={13} />}</span>
      <div><strong>{data.title}</strong><small>{data.employeeName}</small></div>
      <button className="nodrag" type="button" onClick={() => data.onRemove(id)} aria-label={`删除${data.title}`} title="删除节点"><Trash2 size={13} /></button>
    </header>
    <p>{data.instruction}</p>
    <footer><Link2 size={11} />{data.dependencyCount ? `${data.dependencyCount} 个前置节点` : '尚未连接前置节点'}</footer>
    <Handle className="task-dag-handle task-dag-handle-source" type="source" position={Position.Right} title="拖动连接到下一个节点" />
  </article>;
}

function makeAutoNodes(goal: string, employees: AvailableEmployee[]): DagNodeDraft[] {
  const roles = ['拆解目标与整理输入', '完成核心工作并形成中间成果', '复核结果并准备最终交付'];
  return employees.slice(0, Math.min(3, employees.length)).map((employee, index) => ({
    id: `auto-${index + 1}`,
    subscriptionId: employee.id,
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
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<EmployeeFlowNode, Edge> | null>(null);
  const employeeById = useMemo(() => new Map(employees.map(item => [item.id, item])), [employees]);
  const selectedNode = nodes.find(node => node.id === selectedNodeId);
  const canSubmit = Boolean(goal.trim() && employees.length && (mode === 'auto' || nodes.length));

  const chooseDirectory = async () => {
    const result = await window.electronAPI.selectDirectory();
    if (result.success && result.path) setWorkspace(current => ({ ...current, path: result.path!, displayName: result.path!.split(/[\\/]/).filter(Boolean).pop() || result.path! }));
  };

  const updateNode = useCallback((id: string, patch: Partial<DagNodeDraft>) => {
    setNodes(items => items.map(node => node.id === id ? { ...node, ...patch } : node));
  }, []);

  const removeNode = useCallback((id: string) => {
    setNodes(items => items.filter(node => node.id !== id).map(node => ({ ...node, dependsOn: node.dependsOn.filter(dep => dep !== id) })));
    setSelectedNodeId(current => current === id ? null : current);
  }, []);

  const hasDependencyPath = useCallback((items: DagNodeDraft[], nodeId: string, dependencyId: string): boolean => {
    const dependency = items.find(node => node.id === dependencyId);
    return dependency?.dependsOn.some(id => id === nodeId || hasDependencyPath(items, nodeId, id)) ?? false;
  }, []);

  const connectNodes = useCallback((sourceId: string, targetId: string) => {
    setNodes(items => {
      if (sourceId === targetId || hasDependencyPath(items, targetId, sourceId)) return items;
      return items.map(node => node.id === targetId && !node.dependsOn.includes(sourceId)
        ? { ...node, dependsOn: [...node.dependsOn, sourceId] }
        : node);
    });
  }, [hasDependencyPath]);

  const toggleDependency = (nodeId: string, dependencyId: string) => {
    const node = nodes.find(item => item.id === nodeId);
    if (!node) return;
    if (node.dependsOn.includes(dependencyId)) {
      updateNode(nodeId, { dependsOn: node.dependsOn.filter(id => id !== dependencyId) });
      return;
    }
    if (!hasDependencyPath(nodes, nodeId, dependencyId)) connectNodes(dependencyId, nodeId);
  };

  const addEmployeeNode = useCallback((employeeId: string, point?: { x: number; y: number }) => {
    const employee = employeeById.get(employeeId);
    if (!employee) return;
    const id = makeId();
    setNodes(items => [...items, {
      id,
      subscriptionId: employee.id,
      title: `${employee.displayName}的工作`,
      instruction: `请围绕“${goal.trim() || '用户目标'}”完成你的职责。`,
      expectedOutput: '阶段工作成果',
      dependsOn: [],
      x: point?.x ?? 80 + (items.length % 3) * 280,
      y: point?.y ?? 100 + Math.floor(items.length / 3) * 190,
    }]);
    setSelectedNodeId(id);
  }, [employeeById, goal]);

  const flowNodes = useMemo<EmployeeFlowNode[]>(() => nodes.map((node, index) => {
    const employee = employeeById.get(node.subscriptionId);
    return {
      id: node.id,
      type: 'employee',
      position: { x: node.x ?? 80, y: node.y ?? 100 },
      selected: node.id === selectedNodeId,
      data: {
        index: index + 1,
        employeeName: employee?.displayName ?? '未知员工',
        avatar: employee?.avatar ?? '',
        title: node.title,
        instruction: node.instruction,
        dependencyCount: node.dependsOn.length,
        onRemove: removeNode,
      },
    };
  }), [employeeById, nodes, removeNode, selectedNodeId]);

  const flowEdges = useMemo<Edge[]>(() => nodes.flatMap(node => node.dependsOn.map(dependencyId => ({
    id: `${dependencyId}->${node.id}`,
    source: dependencyId,
    target: node.id,
    type: 'smoothstep',
    animated: false,
    className: 'task-dag-edge',
  }))), [nodes]);

  const handleConnect = useCallback((connection: Connection) => {
    if (connection.source && connection.target) connectNodes(connection.source, connection.target);
  }, [connectNodes]);

  const handleEdgesDelete = useCallback((edges: Edge[]) => {
    const removed = new Set(edges.map(edge => `${edge.source}->${edge.target}`));
    setNodes(items => items.map(node => ({
      ...node,
      dependsOn: node.dependsOn.filter(sourceId => !removed.has(`${sourceId}->${node.id}`)),
    })));
  }, []);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const employeeId = event.dataTransfer.getData('application/sep-employee') || draggedEmployeeId;
    if (!employeeId || !flowInstance) return;
    addEmployeeNode(employeeId, flowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    setDraggedEmployeeId(null);
  }, [addEmployeeNode, draggedEmployeeId, flowInstance]);

  const submit = () => {
    if (!canSubmit) return;
    const generated = mode === 'auto' ? makeAutoNodes(goal.trim(), employees) : nodes;
    const first = generated[0];
    if (!first) return;
    onSubmit({ workflowId: initialWorkflow?.id || 'auto-dag', employeeId: first.subscriptionId, workspace, goal: goal.trim(), steps: generated, nodes: generated, mode, inputs: { goal: goal.trim(), accessMode: workspace.accessMode } });
  };

  const autoNodes = useMemo(() => makeAutoNodes(goal.trim() || '当前目标', employees), [employees, goal]);

  return <section className="task-plan-create task-dag-create">
    <header className="task-plan-create-header"><button className="task-plan-back" type="button" onClick={onBack}><ArrowLeft size={16} />任务中心</button><div className="task-dag-title"><span className="eyebrow"><Sparkles size={14} />安排一组员工</span><strong>把目标交代清楚，员工会按 DAG 协作完成</strong></div></header>
    <div className="task-dag-intro"><div><h1>你希望完成什么工作？</h1><p>先选择工作方式，再确认员工、依赖关系和交付结果。</p></div><div className="task-dag-mode-switch" role="tablist" aria-label="创建方式"><button type="button" className={mode === 'auto' ? 'active' : ''} onClick={() => setMode('auto')} role="tab" aria-selected={mode === 'auto'}><Sparkles size={15} /><span><strong>自动编排</strong><small>输入目标，由系统安排员工</small></span></button><button type="button" className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')} role="tab" aria-selected={mode === 'manual'}><Link2 size={15} /><span><strong>员工编排</strong><small>拖动员工，自定义工作流</small></span></button></div></div>
    <label className="task-dag-goal"><span>工作目标</span><textarea value={goal} onChange={event => setGoal(event.target.value)} rows={4} placeholder="例如：整理本季度销售数据，并生成管理层分析报告" autoFocus /></label>
    <div className="task-dag-workspace-row"><div><span>工作目录</span><button type="button" onClick={() => void chooseDirectory()} title="选择工作目录"><FolderOpen size={15} /><strong>{workspace.displayName}</strong></button></div><label><span>权限</span><select value={workspace.accessMode} onChange={event => setWorkspace(current => ({ ...current, accessMode: event.target.value as LocalWorkspaceBinding['accessMode'] }))}><option value="read-write">可修改文件</option><option value="read-only">只读</option></select></label></div>

    {mode === 'auto' ? <section className="task-auto-preview">
      <div className="task-auto-preview-heading"><div><span className="eyebrow"><Sparkles size={13} />系统自动安排</span><h2>提交后由后端选择员工并生成 DAG</h2></div><span>{employees.length} 位可用员工</span></div>
      <div className="task-auto-employee-strip">{autoNodes.map(node => { const employee = employeeById.get(node.subscriptionId); return <span key={node.id}><span className="workspace-avatar">{employee?.avatar || <UserRound size={11} />}</span>{employee?.displayName}</span>; })}</div>
      <p>这里仅展示可参与安排的员工。实际节点和依赖关系由后端根据目标生成。</p>
    </section> : <section className="task-dag-editor">
      <aside className="task-dag-palette">
        <div className="task-dag-panel-heading"><div><strong>硅基员工</strong><small>拖到画布或点击添加</small></div><Bot size={15} /></div>
        <div className="task-dag-employee-list">{employees.map(employee => <button
          key={employee.id}
          type="button"
          draggable
          onDragStart={event => { event.dataTransfer.setData('application/sep-employee', employee.id); event.dataTransfer.effectAllowed = 'copy'; setDraggedEmployeeId(employee.id); }}
          onDragEnd={() => setDraggedEmployeeId(null)}
          onClick={() => addEmployeeNode(employee.id)}
          title={`添加${employee.displayName}`}
        ><span className="workspace-avatar">{employee.avatar || <UserRound size={12} />}</span><span><strong>{employee.displayName}</strong><small>{employee.description}</small></span><Plus size={13} /></button>)}</div>
      </aside>

      <div className="task-dag-canvas-shell">
        <div className="task-dag-canvas-heading"><div><strong>工作流画布</strong><small>拖动空白处移动，滚轮或右上角按钮缩放；从节点右侧连接到下一节点左侧</small></div><span>{nodes.length} 个节点 · {flowEdges.length} 条连接</span></div>
        <div className="task-dag-canvas" role="region" aria-label="员工工作流编排画布">
          <ReactFlow<EmployeeFlowNode, Edge>
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onInit={setFlowInstance}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            onNodeDragStop={(_, node) => updateNode(node.id, { x: node.position.x, y: node.position.y })}
            onConnect={handleConnect}
            onEdgesDelete={handleEdgesDelete}
            isValidConnection={connection => Boolean(connection.source && connection.target && connection.source !== connection.target && !hasDependencyPath(nodes, connection.target, connection.source))}
            onDrop={handleDrop}
            onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
            minZoom={0.35}
            maxZoom={1.8}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
            panOnDrag={[0, 1]}
            zoomOnDoubleClick={false}
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls position="top-right" showInteractive={false} />
            {nodes.length > 4 ? <MiniMap position="bottom-right" pannable zoomable nodeColor="var(--workspace-accent-soft)" maskColor="rgb(249 248 247 / 72%)" /> : null}
          </ReactFlow>
          {nodes.length === 0 ? <div className="task-dag-canvas-empty"><Bot size={24} /><strong>把员工安排到画布上</strong><span>节点不会自动连线，请按实际工作顺序手动连接</span></div> : null}
        </div>
      </div>

      <aside className="task-dag-node-inspector">
        <div className="task-dag-panel-heading"><div><strong>节点设置</strong><small>{selectedNode ? '修改职责和交付' : '先选择一个节点'}</small></div></div>
        {selectedNode ? <>
          <label><span>负责员工</span><select value={selectedNode.subscriptionId} onChange={event => updateNode(selectedNode.id, { subscriptionId: event.target.value })}>{employees.map(employee => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label>
          <label><span>节点名称</span><input value={selectedNode.title} onChange={event => updateNode(selectedNode.id, { title: event.target.value })} /></label>
          <label><span>工作说明</span><textarea value={selectedNode.instruction} onChange={event => updateNode(selectedNode.id, { instruction: event.target.value })} /></label>
          <label><span>预期成果</span><textarea value={selectedNode.expectedOutput} onChange={event => updateNode(selectedNode.id, { expectedOutput: event.target.value })} /></label>
          <div className="task-dag-dependencies"><span>前置节点</span><div>{nodes.filter(node => node.id !== selectedNode.id).map(node => <button key={node.id} type="button" className={selectedNode.dependsOn.includes(node.id) ? 'active' : ''} disabled={!selectedNode.dependsOn.includes(node.id) && hasDependencyPath(nodes, selectedNode.id, node.id)} onClick={() => toggleDependency(selectedNode.id, node.id)}>{node.title}</button>)}</div><small>也可以直接拖动节点两侧的连接点建立关系。</small></div>
          <button className="workspace-secondary-button task-dag-remove-node" type="button" onClick={() => removeNode(selectedNode.id)}><Trash2 size={13} />删除节点</button>
        </> : <div className="task-dag-inspector-empty"><Link2 size={20} /><p>选择节点后可编辑工作说明，也可以在画布中直接拖线建立依赖。</p></div>}
      </aside>
    </section>}

    <footer className="task-dag-actions"><span>{mode === 'auto' ? '确认后会生成 DAG 并进入执行详情' : `${nodes.length} 个节点 · ${flowEdges.length} 条手动连接`}</span><button className="workspace-primary-button" type="button" disabled={!canSubmit} onClick={submit}>{mode === 'auto' ? '生成并开始安排' : '保存编排并开始'}<ChevronRight size={16} /></button></footer>
  </section>;
}
