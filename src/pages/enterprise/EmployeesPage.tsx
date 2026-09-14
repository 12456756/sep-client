/**
 * 硅基员工列表。默认展示企业全貌，可按职能、可用状态、部门筛选。
 * 员工较多时切换成紧凑列表，便于快速找人。
 */

import { LayoutGrid, List, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EmployeeCard } from '../../components/enterprise/EmployeeCard';
import { Empty } from '../../components/enterprise/atoms';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { EmployeeAvailability } from '../../features/enterprise/types';
import { EMPLOYEE_AVAILABILITY } from '../../features/enterprise/vocabulary';

interface Props {
  workspace: EnterpriseWorkspace;
  /** 进入时的默认范围。首页「企业硅基员工」传 all，「已分配给我」传 mine。 */
  scope?: 'mine' | 'all';
}

const SCOPES = [
  { id: 'mine', label: '分配给我的' },
  { id: 'all', label: '企业全部员工' },
] as const;

export function EmployeesPage({ workspace, scope: initialScope }: Props) {
  const { employees } = workspace;
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<'mine' | 'all'>(initialScope ?? 'mine');
  const [role, setRole] = useState('');
  const [department, setDepartment] = useState('');
  const [availability, setAvailability] = useState<'' | EmployeeAvailability>('');
  const [dense, setDense] = useState(false);

  const roles = useMemo(() => [...new Set(employees.map(item => item.roleName))].sort(), [employees]);
  const departments = useMemo(() => [...new Set(employees.map(item => item.department).filter((item): item is string => Boolean(item)))].sort(), [employees]);

  const list = useMemo(() => {
    const term = search.trim().toLowerCase();
    return employees.filter(employee => {
      if (scope === 'mine' && !employee.assignedToMe) return false;
      if (role && employee.roleName !== role) return false;
      if (department && employee.department !== department) return false;
      if (availability && employee.availability !== availability) return false;
      if (!term) return true;
      return [employee.name, employee.roleName, employee.department ?? '', ...employee.goodAt].some(field => field.toLowerCase().includes(term));
    });
  }, [employees, scope, role, department, availability, search]);

  const open = (employeeId: string) => workspace.navigate({ name: 'employee', employeeId });

  return (
    <div className="ent-page">
      <div className="ent-toolbar">
        <label className="ent-find">
          <Search size={14} aria-hidden />
          <input type="search" value={search} placeholder="搜索员工姓名或擅长" aria-label="搜索员工" onChange={event => setSearch(event.target.value)} />
        </label>
        <div className="ent-segment" role="tablist" aria-label="员工范围">
          {SCOPES.map(item => (
            <button key={item.id} type="button" role="tab" aria-selected={scope === item.id} className={scope === item.id ? 'active' : undefined} onClick={() => setScope(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        <select className="ent-select auto" value={role} onChange={event => setRole(event.target.value)} aria-label="按职能筛选">
          <option value="">全部职能</option>
          {roles.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <select className="ent-select auto" value={department} onChange={event => setDepartment(event.target.value)} aria-label="按部门筛选">
          <option value="">全部部门</option>
          {departments.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <select className="ent-select auto" value={availability} onChange={event => setAvailability(event.target.value as '' | EmployeeAvailability)} aria-label="按可用状态筛选">
          <option value="">全部状态</option>
          {(Object.keys(EMPLOYEE_AVAILABILITY) as EmployeeAvailability[]).map(key => (
            <option key={key} value={key}>{EMPLOYEE_AVAILABILITY[key].label}</option>
          ))}
        </select>
        <span className="ent-ask-spacer" />
        <div className="ent-segment icon" role="group" aria-label="展示方式">
          <button type="button" className={dense ? undefined : 'active'} onClick={() => setDense(false)} aria-label="卡片视图" title="卡片视图"><LayoutGrid size={14} aria-hidden /></button>
          <button type="button" className={dense ? 'active' : undefined} onClick={() => setDense(true)} aria-label="紧凑列表" title="紧凑列表"><List size={14} aria-hidden /></button>
        </div>
      </div>

      <p className="ent-result-note">
        共 {list.length} 名员工{scope === 'all' ? '（灰色卡片表示尚未分配给你，只能查看介绍）' : ''}
      </p>

      {!list.length ? (
        <Empty title="没有符合条件的员工">换一个筛选条件，或者查看企业全部员工。</Empty>
      ) : dense ? (
        <div className="ent-emp-list">
          {list.map(employee => (
            <EmployeeCard
              key={employee.id}
              employee={employee}
              compact
              onOpen={open}
              onChat={employee.assignedToMe ? id => open(id) : undefined}
            />
          ))}
        </div>
      ) : (
        <div className="ent-emp-grid">
          {list.map(employee => (
            <EmployeeCard
              key={employee.id}
              employee={employee}
              onOpen={open}
              onChat={employee.assignedToMe ? id => open(id) : undefined}
              onArrange={employee.assignedToMe ? () => workspace.navigate({ name: 'arrange', mode: 'chat', employeeId: employee.id }) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
