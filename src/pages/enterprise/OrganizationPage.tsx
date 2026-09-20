import {
  Building2,
  ChevronDown,
  ChevronRight,
  Maximize2,
  Minimize2,
  Plus,
  Search,
  Users,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import * as React from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { AvailabilityChip, Empty } from '../../components/enterprise/atoms';
import { EmployeeFace } from '../../components/enterprise/EmployeeFace';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import {
  buildOrganizationTree,
  filterOrganizationTree,
  getOrganizationDepartments,
  usableSiliconEmployeesForMember,
  type FilteredOrganizationNode,
  type OrganizationCarbonEmployee,
} from '../../features/enterprise/organization-model';
import { OrganizationEmptyState } from './OrganizationEmptyState';
import type { SiliconEmployee } from '../../features/enterprise/types';

interface Props {
  workspace: Pick<EnterpriseWorkspace, 'employees' | 'navigate'>;
  members?: readonly OrganizationCarbonEmployee[];
  organizationStatus?: 'loading' | 'ready' | 'empty' | 'error';
  organizationError?: string | null;
  onRetry?: () => void;
}

const MIN_ZOOM = 0.7;
const MAX_ZOOM = 1.2;
const ZOOM_STEP = 0.1;
const DEFAULT_ZOOM = 1;
const MEMBERS_PER_PAGE = 6;
const WHEEL_ZOOM_FACTOR = 1.1;
const PAN_THRESHOLD_PX = 4;

/** 部门筛选是“保留部门分支”，搜索才是“高亮命中的那个员工”。 */
function nodeIsHighlighted(node: FilteredOrganizationNode): boolean {
  return node.matched;
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

interface PanState {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
  moved: boolean;
}

export function OrganizationPage({
  workspace,
  members,
  organizationStatus = members === undefined ? 'empty' : 'ready',
  organizationError,
  onRetry,
}: Props): React.JSX.Element {
  if (organizationStatus === 'loading') {
    return (
      <div className="ent-page ent-organization" role="status">
        <Empty title="正在加载组织架构">正在从 SEP 获取企业成员、部门和员工授权关系。</Empty>
      </div>
    );
  }

  if (organizationStatus === 'error') {
    return (
      <div className="ent-page ent-organization" role="alert">
        <Empty title="组织架构加载失败">{organizationError ?? '暂时无法获取组织架构数据，请稍后重试。'}</Empty>
        {onRetry ? <button type="button" className="workspace-primary-button" onClick={onRetry}>重新加载</button> : null}
      </div>
    );
  }

  if (organizationStatus === 'empty' || !members?.length) return <OrganizationEmptyState onRetry={onRetry} />;
  return <OrganizationTreeView workspace={workspace} members={members} />;
}

interface TreeViewProps {
  workspace: Pick<EnterpriseWorkspace, 'employees' | 'navigate'>;
  members: readonly OrganizationCarbonEmployee[];
}

function OrganizationTreeView({ workspace, members }: TreeViewProps): React.JSX.Element {
  const { employees, navigate } = workspace;
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set(members.filter(member => member.parentId === null).map(member => member.id)));
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(zoom);
  const pendingZoomAnchor = useRef<{ left: number; top: number } | null>(null);
  const panRef = useRef<PanState | null>(null);
  const didPanRef = useRef(false);
  const [isPanning, setIsPanning] = useState(false);

  const fitToScreen = useCallback(() => {
    const scroller = treeScrollRef.current;
    const tree = scroller?.querySelector<HTMLElement>('.org-tree');
    if (!scroller || !tree) return;
    const available = scroller.clientWidth;
    const content = tree.scrollWidth;
    if (available <= 0 || content <= 0) return;
    const fit = available / content;
    setZoom(clampZoom(fit));
  }, []);

  const carbonEmployees = members;
  const departments = useMemo(() => getOrganizationDepartments(carbonEmployees), [carbonEmployees]);
  const treeRoots = useMemo(() => buildOrganizationTree(carbonEmployees), [carbonEmployees]);
  const filteredRoots = useMemo(
    () => filterOrganizationTree(treeRoots, search, department),
    [department, search, treeRoots],
  );

  // 搜索 / 部门筛选时自动展开命中分支，让用户看清这个人在公司的哪一层。
  useEffect(() => {
    if (!search.trim() && !department) return;
    setExpandedIds(current => {
      const ids = new Set(current);
      const addPath = (node: FilteredOrganizationNode, ancestors: string[]) => {
        const ownPath = [...ancestors, node.member.id];
        if (node.containsMatch || node.matched) {
          ancestors.forEach(id => ids.add(id));
        }
        node.children.forEach(child => addPath(child, ownPath));
      };
      filteredRoots.forEach(root => {
        ids.add(root.member.id);
        addPath(root, []);
      });
      return ids;
    });
  }, [department, filteredRoots, search]);

  // 首次进入自动“适应屏幕”，让主干完整落在可视区域内。
  useLayoutEffect(() => {
    fitToScreen();
  }, [fitToScreen]);

  // 保持 zoomRef 与最新缩放同步，供原生滚轮监听器读取。
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  const applyWheelZoom = useCallback((deltaY: number, clientX: number, clientY: number) => {
    const scroller = treeScrollRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const pointerX = clientX - rect.left;
    const pointerY = clientY - rect.top;
    const oldZoom = zoomRef.current;
    const factor = deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
    const nextZoom = clampZoom(oldZoom * factor);
    if (nextZoom === oldZoom) return;
    const scale = nextZoom / oldZoom;
    pendingZoomAnchor.current = {
      left: (pointerX + scroller.scrollLeft) * scale - pointerX,
      top: (pointerY + scroller.scrollTop) * scale - pointerY,
    };
    zoomRef.current = nextZoom;
    setZoom(nextZoom);
  }, []);

  // 用原生非被动监听，确保能阻止浏览器默认滚动行为。
  useEffect(() => {
    const scroller = treeScrollRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      applyWheelZoom(event.deltaY, event.clientX, event.clientY);
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, [applyWheelZoom]);

  // 滚轮缩放后校正滚动位置，让指针下方的节点保持不动。
  useLayoutEffect(() => {
    const anchor = pendingZoomAnchor.current;
    const scroller = treeScrollRef.current;
    if (!anchor || !scroller) return;
    pendingZoomAnchor.current = null;
    scroller.scrollLeft = anchor.left;
    scroller.scrollTop = anchor.top;
  }, [zoom]);

  const selectedMember = selectedId
    ? carbonEmployees.find(member => member.id === selectedId) ?? null
    : null;

  const toggleExpanded = (id: string) => {
    setExpandedIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const changeZoom = (delta: number) => {
    setZoom(value => clampZoom(value + delta));
  };

  const handleClose = () => setSelectedId(null);
  const handleOpenEmployee = (employeeId: string) => navigate({ name: 'employee', employeeId });

  const handlePanStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const scroller = treeScrollRef.current;
    if (!scroller) return;
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: scroller.scrollLeft,
      scrollTop: scroller.scrollTop,
      moved: false,
    };
    didPanRef.current = false;
  };

  const handlePanMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    const scroller = treeScrollRef.current;
    if (!pan || !scroller || pan.pointerId !== event.pointerId) return;
    const dx = event.clientX - pan.startX;
    const dy = event.clientY - pan.startY;
    if (!pan.moved && Math.hypot(dx, dy) < PAN_THRESHOLD_PX) return;
    pan.moved = true;
    didPanRef.current = true;
    setIsPanning(true);
    scroller.scrollLeft = pan.scrollLeft - dx;
    scroller.scrollTop = pan.scrollTop - dy;
  };

  const handlePanEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return;
    panRef.current = null;
    setIsPanning(false);
  };

  // 拖拽结束后若发生了移动，则吞掉这次 click，避免误触员工选中。
  const handleTreeClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!didPanRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    didPanRef.current = false;
  };

  useEffect(() => {
    if (!selectedId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);

  const zoomStyle = { '--org-zoom': zoom } as CSSProperties;

  return (
    <div className="ent-page ent-organization">
      <div className="org-page-intro">
        <div className="org-page-title">
          <span className="org-eyebrow"><Building2 size={14} aria-hidden /> 碳基员工组织架构</span>
          <p>查看企业成员组成；点击任意成员，在右侧查看他可以使用哪些硅基员工。</p>
        </div>

      </div>

      <div className={`org-workbench${selectedMember ? ' has-drawer' : ''}`}>
        <section className="org-tree-panel ent-card" aria-label="企业组织关系图">
          <div className="org-panel-toolbar">
            <label className="org-search">
              <Search size={14} aria-hidden />
              <input
                type="search"
                value={search}
                placeholder="搜索员工姓名、部门或职位"
                aria-label="搜索员工"
                onChange={event => setSearch(event.target.value)}
              />
            </label>
            <select
              className="ent-select org-filter"
              value={department}
              onChange={event => setDepartment(event.target.value)}
              aria-label="按部门筛选"
            >
              <option value="">全部部门</option>
              {departments.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            <div className="org-zoom-controls" aria-label="组织架构缩放">
              <button
                type="button"
                className="org-icon-action"
                onClick={() => changeZoom(-ZOOM_STEP)}
                disabled={zoom <= MIN_ZOOM}
                aria-label="缩小组织架构"
                title="缩小"
              >
                <ZoomOut size={15} aria-hidden />
              </button>
              <button
                type="button"
                className="org-zoom-value"
                onClick={() => setZoom(DEFAULT_ZOOM)}
                aria-label={`当前缩放 ${Math.round(zoom * 100)}%，点击恢复 100%`}
                title="恢复 100%"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                className="org-icon-action"
                onClick={() => changeZoom(ZOOM_STEP)}
                disabled={zoom >= MAX_ZOOM}
                aria-label="放大组织架构"
                title="放大"
              >
                <ZoomIn size={15} aria-hidden />
              </button>
              <button
                type="button"
                className="org-icon-action"
                onClick={fitToScreen}
                aria-label="适应屏幕"
                title="适应屏幕"
              >
                <Maximize2 size={15} aria-hidden />
              </button>
            </div>
          </div>

          <div
            className={`org-tree-scroll${isPanning ? ' is-panning' : ''}`}
            ref={treeScrollRef}
            onPointerDown={handlePanStart}
            onPointerMove={handlePanMove}
            onPointerUp={handlePanEnd}
            onPointerCancel={handlePanEnd}
            onClickCapture={handleTreeClickCapture}
          >
            <div className="org-tree-zoom" style={zoomStyle}>
              {filteredRoots.length ? (
                <div className="org-tree">
                  {filteredRoots.map(root => (
                    <OrganizationTreeNodeView
                      key={root.member.id}
                      node={root}
                      level={0}
                      selectedId={selectedId}
                      expandedIds={expandedIds}
                      visibleCounts={visibleCounts}
                      onSelect={setSelectedId}
                      onToggleExpanded={toggleExpanded}
                      onMore={id => setVisibleCounts(current => ({
                        ...current,
                        [id]: (current[id] ?? MEMBERS_PER_PAGE) + MEMBERS_PER_PAGE,
                      }))}
                    />
                  ))}
                </div>
              ) : (
                <Empty title="没有匹配的成员">换个关键词或部门试试，组织树会保留命中成员的上级路径。</Empty>
              )}
            </div>
          </div>
        </section>

        <OrganizationDrawer
          member={selectedMember}
          employees={employees}
          onOpenEmployee={handleOpenEmployee}
          onClose={handleClose}
        />
      </div>
    </div>
  );
}

interface TreeNodeProps {
  node: FilteredOrganizationNode;
  level: number;
  selectedId: string | null;
  expandedIds: Set<string>;
  visibleCounts: Record<string, number>;
  onSelect: (id: string) => void;
  onToggleExpanded: (id: string) => void;
  onMore: (id: string) => void;
}

function OrganizationTreeNodeView(props: TreeNodeProps) {
  const { node, level, selectedId, expandedIds, visibleCounts, onSelect, onToggleExpanded, onMore } = props;
  const isRoot = node.member.kind === 'root';
  const hasChildren = node.children.length > 0;
  const expanded = expandedIds.has(node.member.id);
  const highlighted = nodeIsHighlighted(node);
  const reserve = node.member.isCurrent ? 1 : 0;
  const pageCount = Math.max(1, node.children.length - reserve);
  const visible = Math.min(pageCount, visibleCounts[node.member.id] ?? MEMBERS_PER_PAGE);
  const memberCount = node.children.length;
  const hiddenCount = memberCount - visible;

  const childrenToShow = node.children.slice(0, visible);

  return (
    <div className="org-tree-node">
      <div className={`org-tree-card${isRoot ? ' root' : ''}${highlighted ? ' match' : ''}${node.member.id === selectedId ? ' selected' : ''}`}>
        <div className="org-tree-card-body">
          <button
            type="button"
            className="org-tree-card-main"
            onClick={() => onSelect(node.member.id)}
            aria-pressed={node.member.id === selectedId}
          >
            {isRoot ? (
              <span className="org-enterprise-mark" aria-hidden>
                {node.member.name.slice(0, 1)}
              </span>
            ) : (
              <EmployeeFace name={node.member.name} size="md" round={false} />
            )}
            <span className="org-tree-copy">
              <span className="org-card-title">
                <strong title={node.member.name}>{node.member.name}</strong>
                <MemberTone member={node.member} />
              </span>
              <small>{node.member.position}</small>
              <small className="org-tree-meta">{isRoot ? '企业组织' : node.member.department}</small>
              {hasChildren ? (
                <span className="org-tree-count">
                  <Users size={11} aria-hidden />
                  下级节点 {memberCount} 项
                </span>
              ) : null}
            </span>
          </button>
          {!isRoot && hasChildren ? (
            <button
              type="button"
              className={`org-tree-toggle${expanded ? ' open' : ''}`}
              onClick={() => onToggleExpanded(node.member.id)}
              aria-expanded={expanded}
              aria-label={expanded ? '收起下属成员' : '展开下属成员'}
            >
              {expanded ? <Minimize2 size={13} aria-hidden /> : <Plus size={13} aria-hidden />}
              {expanded ? '收起成员' : '展开成员'}
            </button>
          ) : null}
        </div>
      </div>

      {hasChildren && expanded ? (
        <div className="org-tree-children">
          <div className="org-tree-branch-line" aria-hidden />
          <div className="org-tree-children-list">
            {childrenToShow.map((child, index) => (
              <div key={child.member.id} className="org-tree-child">
                <span className="org-tree-child-connector" aria-hidden style={{ '--child-index': index } as CSSProperties} />
                <OrganizationTreeNodeView
                  node={child}
                  level={level + 1}
                  selectedId={selectedId}
                  expandedIds={expandedIds}
                  visibleCounts={visibleCounts}
                  onSelect={onSelect}
                  onToggleExpanded={onToggleExpanded}
                  onMore={onMore}
                />
              </div>
            ))}
            {hiddenCount > 0 ? (
              <button type="button" className="org-tree-more" onClick={() => onMore(node.member.id)}>
                查看更多 {hiddenCount} 人
                <ChevronDown size={13} aria-hidden />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MemberTone({ member }: { member: OrganizationCarbonEmployee }) {
  if (member.kind === 'root') return <span className="org-type-chip">企业</span>;
  if (member.kind === 'department') return <span className="org-type-chip">部门</span>;
  if (member.isCurrent) return <span className="org-type-chip human">当前成员</span>;
  if (member.kind === 'leader') return <span className="org-type-chip">部门负责人</span>;
  return <span className="org-type-chip neutral">碳基员工</span>;
}

interface OrganizationDrawerProps {
  member: OrganizationCarbonEmployee | null;
  employees: readonly SiliconEmployee[];
  onOpenEmployee: (employeeId: string) => void;
  onClose: () => void;
}

function OrganizationDrawer({ member, employees, onOpenEmployee, onClose }: OrganizationDrawerProps): React.JSX.Element | null {
  if (!member) return null;

  const usable = usableSiliconEmployeesForMember(member, employees);

  return (
    <aside className="org-drawer ent-card" aria-label="成员详情">
      <header className="org-drawer-head">
        <EmployeeFace name={member.name} size="lg" variant="portrait" round={false} />
        <div className="org-drawer-id">
          <div className="org-card-title">
            <h2>{member.name}</h2>
            <MemberTone member={member} />
          </div>
          <p>{member.position}</p>
          <small>{member.department}</small>
        </div>
        <button type="button" className="org-icon-action" onClick={onClose} aria-label="关闭成员详情" title="关闭">
          <X size={14} aria-hidden />
        </button>
      </header>

      <div className="org-drawer-stats">
        <div><dt>所属部门</dt><dd>{member.department || '企业直属'}</dd></div>
        <div><dt>可使用硅基员工</dt><dd>{usable.length} 人</dd></div>
      </div>

      <div className="org-detail-section-head">
        <h3>他可使用的硅基员工</h3>
        <span>{usable.length}</span>
      </div>
      {usable.length ? (
        <div className="org-drawer-team">
          {usable.map(employee => (
            <button
              key={employee.id}
              type="button"
              className="org-drawer-team-row"
              onClick={() => onOpenEmployee(employee.id)}
              disabled={!employee.assignedToMe}
              title={employee.assignedToMe ? '查看员工详情' : '仅展示组织授权，当前账号不可操作此员工'}
              aria-label={'查看 ' + employee.name + ' 详情'}
            >
              <EmployeeFace employee={employee} size="sm" round />
              <span className="org-drawer-team-copy">
                <strong title={employee.name}>{employee.name}</strong>

              </span>
              <AvailabilityChip value={employee.availability} />
              <ChevronRight size={14} aria-hidden />
            </button>
          ))}
        </div>
      ) : (
        <Empty title="暂未配置可用的硅基员工">平台返回授权关系后，这里会显示该成员可以使用的员工。</Empty>
      )}
    </aside>
  );
}
