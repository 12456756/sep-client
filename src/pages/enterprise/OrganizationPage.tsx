import {
  ArrowRight,
  Building2,
  ChevronDown,
  ChevronRight,
  Search,
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

        <div className="org-tree-scroll">
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

  return (
    <section
      className={`org-tree-branch${selected ? " selected" : ""}${department.parentDepartmentId ? " nested" : ""}`}
      aria-label={`${department.member.name}组织分支`}
      data-department-id={department.member.id}
      data-parent-department-id={department.parentDepartmentId ?? undefined}
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
              <Building2 size={17} aria-hidden />
            </span>
            <span className="org-tree-node-copy">
              <strong title={department.member.name}>{department.member.name}</strong>
              <small>{department.members.length} 位成员{hasChildren ? ` · ${department.children.length} 个下级部门` : ""}</small>
            </span>
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
          <EmployeeFace name={member.name} size="sm" round />
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
