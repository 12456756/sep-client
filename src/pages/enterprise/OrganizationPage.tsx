import {
  ArrowRight,
  Bot,
  Boxes,
  Building2,
  ChevronDown,
  ChevronRight,
  Code2,
  Handshake,
  Headphones,
  Megaphone,
  Palette,
  Search,
  Settings2,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import * as React from "react";
import { useMemo, useState } from "react";
import { AvailabilityChip, Empty } from "../../components/enterprise/atoms";
import { EmployeeFace } from "../../components/enterprise/EmployeeFace";
import type { EnterpriseWorkspace } from "../../features/enterprise/useEnterpriseWorkspace";
import type { OrganizationCarbonEmployee } from "../../features/enterprise/organization-model";
import { usableSiliconEmployeesForMember } from "../../features/enterprise/organization-model";
import {
  buildOrganizationRelation,
  filterOrganizationRelation,
  type OrganizationRelationDepartment,
} from "../../features/enterprise/organization-map-model";
import { OrganizationEmptyState } from "./OrganizationEmptyState";
import type { SiliconEmployee } from "../../features/enterprise/types";

const UNASSIGNED_DEPARTMENT_ID = "__unassigned__";

/**
 * 部门图标：按部门名称里的关键词匹配形状。
 * 组织架构里有几十个部门，靠关键词命中比在数据层新增字段更稳——
 * 平台不会为「研发组」单独给出一个图标 ID，但名称里一定带「研发」。
 *
 * 形状和颜色是两套独立的编码：形状表达「这是什么职能」，颜色表达
 * 「这是哪个部门」。两套并存，任一通道失效（灰度打印、色盲）都还读得出来。
 */
const DEPARTMENT_ICONS: readonly {
  keywords: readonly string[];
  icon: LucideIcon;
}[] = [
  { keywords: ["技术", "研发", "开发", "架构"], icon: Code2 },
  { keywords: ["测试", "质量", "QA"], icon: Boxes },
  { keywords: ["运维", "基础设施", "IT"], icon: Settings2 },
  { keywords: ["产品", "设计", "UI", "交互"], icon: Palette },
  { keywords: ["市场", "品牌", "增长", "运营"], icon: Megaphone },
  { keywords: ["销售", "商务", "客户", "渠道"], icon: Handshake },
  { keywords: ["财务", "人事", "人力", "行政"], icon: Wallet },
  { keywords: ["客服", "服务", "支持"], icon: Headphones },
];

function departmentIcon(name: string): LucideIcon {
  for (const entry of DEPARTMENT_ICONS) {
    if (entry.keywords.some(keyword => name.includes(keyword))) {
      return entry.icon;
    }
  }
  return Building2;
}

/**
 * 一级部门的识别色。
 *
 * 刻意不含品牌红：红只用于「选中 / 悬停 / 有可用硅基员工」这几种状态。
 * 如果某个部门本身是红的，「这个部门是红的」和「这个部门被选中了」
 * 就会互相干扰 —— 一个通道只能表达一件事。
 *
 * 也不含灰阶：留给下级部门，让「彩色 = 一级」「灰 = 下级」成为稳定的层级信号。
 */
const DEPARTMENT_HUES = [
  "#3b82f6", // 蓝
  "#14b8a6", // 青绿
  "#8b5cf6", // 紫
  "#f59e0b", // 琥珀
  "#ec4899", // 玫红
  "#10b981", // 绿
  "#f97316", // 橙
] as const;

/**
 * 按 id 取色，而不是按名称或列表下标。
 * 下标会随排序变化导致同一个部门换色；名称会因改名而换色。
 * id 稳定，所以颜色也稳定 —— 用户能靠颜色记住「蓝的是技术部」。
 */
function departmentHue(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return DEPARTMENT_HUES[hash % DEPARTMENT_HUES.length];
}

/**
 * 为一批部门分配互不相同的识别色。
 *
 * 纯哈希会撞色（7 个色相配 6 个部门，按生日悖论约一半概率重复），
 * 相邻部门同色看起来像缺陷。这里以哈希值为起点顺序探测，
 * 既保留「同一个部门颜色稳定」，又保证同屏可见的部门两两不同。
 */
function assignDepartmentHues(ids: readonly string[]): Map<string, string> {
  const taken = new Set<string>();
  const result = new Map<string, string>();
  for (const id of ids) {
    const start = DEPARTMENT_HUES.indexOf(departmentHue(id) as typeof DEPARTMENT_HUES[number]);
    for (let step = 0; step < DEPARTMENT_HUES.length; step += 1) {
      const candidate = DEPARTMENT_HUES[(start + step) % DEPARTMENT_HUES.length];
      if (!taken.has(candidate)) {
        taken.add(candidate);
        result.set(id, candidate);
        break;
      }
    }
  }
  return result;
}

type OrganizationStatus = "loading" | "ready" | "empty" | "error";

interface Props {
  workspace: Pick<EnterpriseWorkspace, "employees" | "navigate">;
  members?: readonly OrganizationCarbonEmployee[];
  organizationStatus?: OrganizationStatus;
  organizationError?: string | null;
  onRetry?: () => void;
}

export function OrganizationPage({
  workspace,
  members,
  organizationStatus = members === undefined ? "empty" : "ready",
  organizationError,
  onRetry,
}: Props): React.JSX.Element {
  if (organizationStatus === "loading") {
    return (
      <div className="ent-page ent-organization" role="status">
        <Empty title="正在加载组织架构">
          正在从 SEP 获取企业成员、部门和员工授权关系。
        </Empty>
      </div>
    );
  }
  if (organizationStatus === "error") {
    return (
      <div className="ent-page ent-organization" role="alert">
        <Empty title="组织架构加载失败">
          {organizationError ?? "暂时无法获取组织架构数据，请稍后重试。"}
        </Empty>
        {onRetry ? (
          <button
            type="button"
            className="workspace-primary-button"
            onClick={onRetry}
          >
            重新加载
          </button>
        ) : null}
      </div>
    );
  }
  if (organizationStatus === "empty" || !members?.length)
    return <OrganizationEmptyState onRetry={onRetry} />;
  return <OrganizationTreeView workspace={workspace} members={members} />;
}

function OrganizationTreeView({
  workspace,
  members,
}: {
  workspace: Pick<EnterpriseWorkspace, "employees" | "navigate">;
  members: readonly OrganizationCarbonEmployee[];
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<
    string | null
  >(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [expandedDepartmentIdsState, setExpandedDepartmentIdsState] =
    useState<Set<string> | null>(null);
  const [expandedMemberIdsState, setExpandedMemberIdsState] =
    useState<Set<string> | null>(null);
  const orgCanvasRef = React.useRef<HTMLDivElement | null>(null);
  const panRef = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startScrollLeft: number;
    startScrollTop: number;
    moved: boolean;
  } | null>(null);
  const panListenersRef = React.useRef<{
    move: (event: PointerEvent) => void;
    finish: (event: PointerEvent) => void;
  } | null>(null);
  const suppressClickRef = React.useRef(false);
  const suppressClickTimerRef = React.useRef<number | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const organization = useMemo(
    () => buildOrganizationRelation(members),
    [members],
  );
  const visibleOrganization = useMemo(
    () => filterOrganizationRelation(organization, query),
    [organization, query],
  );
  const departmentGroups = useMemo(() => {
    const groups = [...visibleOrganization.rootDepartments];
    if (visibleOrganization.unassignedMembers.length) {
      groups.push({
        member: {
          id: UNASSIGNED_DEPARTMENT_ID,
          name: "未归属部门",
          position: "部门",
          department: "",
          employeeIds: [],
          isCurrent: false,
          kind: "department",
          parentId: visibleOrganization.enterprise?.id ?? null,
        },
        depth: 0,
        parentDepartmentId: null,
        members: visibleOrganization.unassignedMembers,
        children: [],
      });
    }
    return groups;
  }, [visibleOrganization]);

  // 一级部门的识别色：同屏内两两不同，且随部门 id 稳定。
  const departmentHues = useMemo(
    () => assignDepartmentHues(departmentGroups.map((group) => group.member.id)),
    [departmentGroups],
  );

  const defaultDepartmentId = useMemo(() => {
    const currentDepartment = visibleOrganization.departments.find((group) =>
      group.members.some((member) => member.isCurrent),
    );
    return currentDepartment?.member.id ?? departmentGroups[0]?.member.id ?? null;
  }, [departmentGroups, visibleOrganization.departments]);
  const defaultMemberId =
    [...visibleOrganization.departments.flatMap((group) => group.members), ...visibleOrganization.unassignedMembers]
      .find((member) => member.isCurrent)?.id ?? null;
  const defaultExpandedDepartmentIds = useMemo(() => {
    if (query.trim())
      return new Set(visibleOrganization.departments.map((group) => group.member.id));
    const expanded = new Set<string>();
    let currentId = defaultDepartmentId;
    const byId = new Map(visibleOrganization.departments.map((group) => [group.member.id, group]));
    while (currentId) {
      if (expanded.has(currentId)) break;
      expanded.add(currentId);
      currentId = byId.get(currentId)?.parentDepartmentId ?? "";
    }
    return expanded;
  }, [defaultDepartmentId, query, visibleOrganization.departments]);
  const defaultExpandedMemberIds = useMemo(() => {
    if (query.trim())
      return new Set(
        [...visibleOrganization.departments.flatMap((group) =>
          group.members.map((member) => member.id),
        ), ...visibleOrganization.unassignedMembers.map((member) => member.id)],
      );
    return defaultMemberId ? new Set([defaultMemberId]) : new Set<string>();
  }, [defaultMemberId, query, visibleOrganization.departments, visibleOrganization.unassignedMembers]);
  const expandedDepartmentIds =
    expandedDepartmentIdsState ?? defaultExpandedDepartmentIds;
  const expandedMemberIds = expandedMemberIdsState ?? defaultExpandedMemberIds;
  const activeMemberId = selectedMemberId ?? defaultMemberId;
  const activeMember = activeMemberId
    ? (members.find((member) => member.id === activeMemberId) ?? null)
    : null;
  const openEmployee = (employeeId: string) =>
    workspace.navigate({ name: "employee", employeeId });
  const startCanvasPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as HTMLElement).closest("input, textarea, select")) return;
    const canvas = orgCanvasRef.current;
    if (!canvas) return;

    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = null;
    }
    suppressClickRef.current = false;
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: canvas.scrollLeft,
      startScrollTop: canvas.scrollTop,
      moved: false,
    };

    const move = (pointerEvent: PointerEvent) => {
      const pan = panRef.current;
      if (!pan || pointerEvent.pointerId !== pan.pointerId) return;
      const deltaX = pointerEvent.clientX - pan.startX;
      const deltaY = pointerEvent.clientY - pan.startY;
      if (!pan.moved && Math.hypot(deltaX, deltaY) > 5) {
        pan.moved = true;
        setIsPanning(true);
      }
      if (!pan.moved) return;
      if (pointerEvent.cancelable) pointerEvent.preventDefault();
      canvas.scrollLeft = pan.startScrollLeft - deltaX;
      canvas.scrollTop = pan.startScrollTop - deltaY;
    };
    const finish = (pointerEvent: PointerEvent) => {
      const pan = panRef.current;
      if (!pan || pointerEvent.pointerId !== pan.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      panListenersRef.current = null;
      panRef.current = null;
      setIsPanning(false);
      if (pan.moved) {
        suppressClickRef.current = true;
        suppressClickTimerRef.current = window.setTimeout(() => {
          suppressClickRef.current = false;
          suppressClickTimerRef.current = null;
        }, 400);
      }
    };
    panListenersRef.current = { move, finish };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  const handleCanvasClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = false;
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = null;
    }
  };
  const panCanvasWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const distance = event.shiftKey ? 220 : 90;
    const movement = {
      ArrowLeft: [-distance, 0],
      ArrowRight: [distance, 0],
      ArrowUp: [0, -distance],
      ArrowDown: [0, distance],
    }[event.key];
    if (!movement || !orgCanvasRef.current) return;
    event.preventDefault();
    orgCanvasRef.current.scrollLeft += movement[0];
    orgCanvasRef.current.scrollTop += movement[1];
  };

  React.useEffect(() => () => {
    const listeners = panListenersRef.current;
    if (listeners) {
      window.removeEventListener("pointermove", listeners.move);
      window.removeEventListener("pointerup", listeners.finish);
      window.removeEventListener("pointercancel", listeners.finish);
    }
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current);
    }
  }, []);
  const toggleDepartment = (departmentId: string) => {
    setExpandedDepartmentIdsState((current) => {
      const next = new Set(current ?? defaultExpandedDepartmentIds);
      if (next.has(departmentId)) next.delete(departmentId);
      else next.add(departmentId);
      return next;
    });
  };

  return (
    <div className="ent-page ent-organization org-tree-page">
      <section className="org-tree-view" aria-label="企业组织架构树">
        <div className="org-tree-toolbar">
          <label className="org-tree-search">
            <Search size={15} aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索部门、姓名或职位"
              aria-label="搜索部门、姓名或职位"
            />
          </label>
        </div>

        <div
          ref={orgCanvasRef}
          className={`org-tree-scroll${isPanning ? " is-panning" : ""}`}
          role="region"
          aria-label="企业组织关系画布，可拖拽平移；聚焦后可使用方向键移动"
          tabIndex={0}
          onPointerDown={startCanvasPan}
          onClickCapture={handleCanvasClickCapture}
          onKeyDown={panCanvasWithKeyboard}
        >
          {departmentGroups.length ? (
            <div className="org-tree-shell">
              <div className="org-tree-company-column">
                <div className="org-tree-company-node">
                  <span className="org-tree-node-icon">
                    <Building2 size={20} aria-hidden />
                  </span>
                  <span className="org-tree-node-copy">
                    <strong>
                      {visibleOrganization.enterprise?.name ?? "企业组织"}
                    </strong>
                    <small>公司</small>
                  </span>
                </div>
                <div className="org-tree-company-meta">
                  <span className="org-tree-status-dot" aria-hidden />
                  <span>
                    {
                      members.filter(
                        (member) =>
                          member.kind !== "root" &&
                          member.kind !== "department",
                      ).length
                    }{" "}
                    位碳基员工
                  </span>
                </div>
              </div>

              <div className="org-tree-track">
                {departmentGroups.map((department) => (
                  <DepartmentBranch
                    key={department.member.id}
                    department={department}
                    departmentHues={departmentHues}
                    selectedDepartmentId={selectedDepartmentId}
                    selectedMemberId={activeMemberId}
                    siliconEmployees={workspace.employees}
                    expanded={expandedDepartmentIds.has(department.member.id)}
                    onToggle={() => toggleDepartment(department.member.id)}
                    expandedDepartmentIds={expandedDepartmentIds}
                    onToggleDepartment={toggleDepartment}
                    onDepartmentSelect={(departmentId) => {
                      setSelectedDepartmentId(departmentId);
                      setSelectedMemberId(null);
                    }}
                    expandedMemberIds={expandedMemberIds}
                    onToggleMember={(memberId) => {
                      setExpandedMemberIdsState((current) => {
                        const next = new Set(
                          current ?? defaultExpandedMemberIds,
                        );
                        if (next.has(memberId)) next.delete(memberId);
                        else next.add(memberId);
                        return next;
                      });
                    }}
                    onMemberSelect={(member) => {
                      setSelectedDepartmentId(member.parentId);
                      setSelectedMemberId(member.id);
                    }}
                    onOpenEmployee={openEmployee}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="org-tree-no-results">
              <Empty title="没有找到匹配的组织成员">
                试试部门名称、姓名或职位。
              </Empty>
            </div>
          )}
        </div>

        {activeMember ? (
          <div className="org-tree-selection-note" aria-live="polite">
            <span>当前关系</span>
            <strong>{activeMember.name}</strong>
            <ArrowRight size={14} aria-hidden />
            <span>
              {
                usableSiliconEmployeesForMember(
                  activeMember,
                  workspace.employees,
                ).length
              }{" "}
              位硅基员工
            </span>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function DepartmentBranch({
  department,
  departmentHues,
  selectedDepartmentId,
  selectedMemberId,
  siliconEmployees,
  expanded,
  onToggle,
  expandedDepartmentIds,
  onToggleDepartment,
  onDepartmentSelect,
  expandedMemberIds,
  onToggleMember,
  onMemberSelect,
  onOpenEmployee,
}: {
  department: OrganizationRelationDepartment;
  /** 一级部门的识别色分配表，递归传递，下钻层级后颜色保持一致。 */
  departmentHues: ReadonlyMap<string, string>;
  selectedDepartmentId: string | null;
  selectedMemberId: string | null;
  siliconEmployees: readonly SiliconEmployee[];
  expanded: boolean;
  onToggle: () => void;
  expandedDepartmentIds: ReadonlySet<string>;
  onToggleDepartment: (departmentId: string) => void;
  onDepartmentSelect: (departmentId: string) => void;
  expandedMemberIds: ReadonlySet<string>;
  onToggleMember: (memberId: string) => void;
  onMemberSelect: (member: OrganizationCarbonEmployee) => void;
  onOpenEmployee: (employeeId: string) => void;
}): React.JSX.Element {
  const selected = selectedDepartmentId === department.member.id;
  const hasChildren = department.children.length > 0;
  const hasContent = department.members.length > 0 || hasChildren;
  // 形状表达职能，颜色表达部门身份（仅一级部门着色，下级部门留中性灰）。
  const visual = departmentIcon(department.member.name);
  const DepartmentIcon = department.member.id === UNASSIGNED_DEPARTMENT_ID ? Users : visual;
  const isTopLevel = !department.parentDepartmentId;
  const hue = isTopLevel ? departmentHues.get(department.member.id) : undefined;
  const memberFaces = department.members.slice(0, 4);

  return (
    <section
      className={`org-tree-branch${selected ? " selected" : ""}${isTopLevel ? "" : " nested"}`}
      aria-label={`${department.member.name}组织分支`}
      data-department-id={department.member.id}
      data-parent-department-id={department.parentDepartmentId ?? undefined}
      style={hue ? ({ "--dept-hue": hue } as React.CSSProperties) : undefined}
    >
      <div className="org-tree-branch-grid">
        <div className="org-tree-department-slot">
          <button
            type="button"
            className={`org-tree-node org-tree-department-node${selected ? " selected" : ""}`}
            style={{ "--org-depth": department.depth } as React.CSSProperties}
            onClick={() => {
              onDepartmentSelect(department.member.id);
              if (hasContent) onToggle();
            }}
            aria-pressed={selected}
            aria-expanded={hasContent ? expanded : undefined}
            aria-label={`${department.member.name}${hasContent ? (expanded ? "，收起下级" : "，展开下级") : ""}`}
          >
            <span className="org-tree-node-icon">
              <DepartmentIcon size={17} aria-hidden />
            </span>
            <span className="org-tree-node-copy">
              <strong title={department.member.name}>{department.member.name}</strong>
              <small>{department.members.length} 位成员{hasChildren ? ` · ${department.children.length} 个下级部门` : ""}</small>
            </span>
            {/* 成员头像叠放：不展开也能看出这个部门有谁 */}
            {memberFaces.length ? (
              <span className="org-tree-dept-faces" aria-hidden>
                {memberFaces.map((member) => (
                  <EmployeeFace key={member.id} employee={member} name={member.name} size="sm" round />
                ))}
                {department.members.length > memberFaces.length ? (
                  <span className="org-tree-dept-faces-more">+{department.members.length - memberFaces.length}</span>
                ) : null}
              </span>
            ) : null}
            {/* 可用硅基员工数：全屏唯一持续有色的元素，把视线引到产品卖点上 */}
            {(() => {
              const count = new Set(
                department.members.flatMap((member) =>
                  usableSiliconEmployeesForMember(member, siliconEmployees).map((employee) => employee.id),
                ),
              ).size;
              return count ? (
                <span className="org-tree-dept-silicon" title={`${count} 位可用硅基员工`}>
                  <Bot size={12} aria-hidden />
                  {count}
                </span>
              ) : null;
            })()}
            {hasContent ? (expanded ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />) : null}
          </button>
        </div>

        <div className={`org-tree-branch-outlet${expanded ? "" : " collapsed"}`}>
          {expanded ? (
            <>
              {department.members.length ? (
                <div className="org-tree-member-flow">
                  {department.members.map((member) => (
                    <MemberRelationRow
                      key={member.id}
                      member={member}
                      selected={selectedMemberId === member.id}
                      siliconEmployees={siliconEmployees}
                      siliconExpanded={expandedMemberIds.has(member.id)}
                      onToggleSilicon={() => onToggleMember(member.id)}
                      onSelect={() => onMemberSelect(member)}
                      onOpenEmployee={onOpenEmployee}
                    />
                  ))}
                </div>
              ) : null}

              {hasChildren ? (
                <div className="org-tree-subbranches" aria-label={`${department.member.name}下级部门`}>
                  {department.children.map((child) => (
                    <DepartmentBranch
                      key={child.member.id}
                      department={child}
                      departmentHues={departmentHues}
                      selectedDepartmentId={selectedDepartmentId}
                      selectedMemberId={selectedMemberId}
                      siliconEmployees={siliconEmployees}
                      expanded={expandedDepartmentIds.has(child.member.id)}
                      onToggle={() => onToggleDepartment(child.member.id)}
                      expandedDepartmentIds={expandedDepartmentIds}
                      onToggleDepartment={onToggleDepartment}
                      onDepartmentSelect={() => onDepartmentSelect(child.member.id)}
                      expandedMemberIds={expandedMemberIds}
                      onToggleMember={onToggleMember}
                      onMemberSelect={onMemberSelect}
                      onOpenEmployee={onOpenEmployee}
                    />
                  ))}
                </div>
              ) : null}

              {!department.members.length && !hasChildren ? (
                <div className="org-tree-branch-empty">该部门暂未分配直属成员</div>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              className="org-tree-collapsed-summary"
              onClick={onToggle}
              aria-expanded={false}
              aria-label={`展开${department.member.name}下级`}
            >
              <span className="org-tree-collapsed-counts" aria-hidden="true">
                {department.members.length ? <span><strong>{department.members.length}</strong> 成员</span> : null}
                {hasChildren ? <span><strong>{department.children.length}</strong> 部门</span> : null}
                {!hasContent ? <span>暂无成员</span> : null}
              </span>
              <ChevronRight size={14} aria-hidden />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function MemberRelationRow({
  member,
  selected,
  siliconEmployees,
  siliconExpanded,
  onToggleSilicon,
  onSelect,
  onOpenEmployee,
}: {
  member: OrganizationCarbonEmployee;
  selected: boolean;
  siliconEmployees: readonly SiliconEmployee[];
  siliconExpanded: boolean;
  onToggleSilicon: () => void;
  onSelect: () => void;
  onOpenEmployee: (employeeId: string) => void;
}): React.JSX.Element {
  const usableEmployees = usableSiliconEmployeesForMember(
    member,
    siliconEmployees,
  );

  return (
    <div className={`org-tree-member-row${selected ? " selected" : ""}`}>
      <div className="org-tree-carbon-column">
        <button
          type="button"
          className={`org-tree-node org-tree-carbon-node${selected ? " selected" : ""}${member.isCurrent ? " current" : ""}`}
          onClick={() => {
            onSelect();
            if (usableEmployees.length) onToggleSilicon();
          }}
          aria-pressed={selected}
          aria-expanded={usableEmployees.length ? siliconExpanded : undefined}
          aria-label={`${member.name}${usableEmployees.length ? (siliconExpanded ? "，收起硅基员工" : "，展开硅基员工") : ""}`}
        >
          <EmployeeFace employee={member} name={member.name} size="sm" round />
          <span className="org-tree-node-copy">
            <strong>
              {member.name}
              {member.isCurrent ? <em>我</em> : null}
            </strong>
            <small>{member.position || "碳基员工"}</small>
          </span>
          {usableEmployees.length ? (
            siliconExpanded ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />
          ) : null}
        </button>
      </div>

      <div
        className={`org-tree-silicon-flow${siliconExpanded ? "" : " collapsed"}`}
      >
        {siliconExpanded ? (
          usableEmployees.length ? (
            usableEmployees.map((employee) => (
              <button
                key={employee.id}
                type="button"
                className="org-tree-silicon-node"
                onClick={() => onOpenEmployee(employee.id)}
                disabled={!employee.assignedToMe}
                title={
                  employee.assignedToMe
                    ? "查看员工详情"
                    : "仅展示组织授权，当前账号不可操作此员工"
                }
              >
                <EmployeeFace employee={employee} size="sm" round />
                <span className="org-tree-node-copy">
                  <strong>{employee.name}</strong>
                  <small>{employee.roleName || "硅基员工"}</small>
                </span>
                <AvailabilityChip value={employee.availability} />
                <ChevronRight size={14} aria-hidden />
              </button>
            ))
          ) : (
            <div className="org-tree-silicon-empty">暂未配置可用的硅基员工</div>
          )
        ) : usableEmployees.length ? (
          <div className="org-tree-silicon-collapsed" aria-live="polite">
            <span className="org-tree-silicon-count" aria-hidden="true">
              <strong>{usableEmployees.length}</strong> 位硅基员工
            </span>
            <ChevronRight size={14} aria-hidden />
          </div>
        ) : (
          <div className="org-tree-silicon-empty">暂未配置可用的硅基员工</div>
        )}
      </div>
    </div>
  );
}
