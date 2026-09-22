/**
 * 硅基员工列表 - Phase 3 重构
 *
 * 关键变化：
 * - 简化英雄区（180px 高）：眉标 + 标题 + 统计 + 右侧照片
 * - 二级过滤栏移到页面内（范围 tabs + 状态下拉 + 搜索 + 视图切换）
 * - 网格视图 4 列（原 3 列），单卡 280px 宽
 * - 卡片悬停时轻微上浮 2px + 阴影加深
 */

import { LayoutGrid, List, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EmployeeCard } from '../../components/enterprise/EmployeeCard';
import { Empty } from '../../components/enterprise/atoms';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { EmployeeAvailability } from '../../features/enterprise/types';
import { EMPLOYEE_AVAILABILITY } from '../../features/enterprise/vocabulary';
import { useDebounce } from '../../hooks/useDebounce';
import { VirtualList, VirtualGrid } from '../../components/VirtualList';

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
  const { employees, overview } = workspace;
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<'mine' | 'all'>(initialScope ?? 'mine');
  const [availability, setAvailability] = useState<'' | EmployeeAvailability>('');
  const [dense, setDense] = useState(false);

  // 使用防抖优化搜索性能
  const debouncedSearch = useDebounce(search, 300);

  const list = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    return employees.filter(employee => {
      if (scope === 'mine' && !employee.assignedToMe) return false;
      if (availability && employee.availability !== availability) return false;
      if (!term) return true;
      return [employee.name, ...employee.goodAt].some(field => field.toLowerCase().includes(term));
    });
  }, [employees, scope, availability, debouncedSearch]);

  const open = (employeeId: string) => workspace.navigate({ name: 'employee', employeeId });

  return (
    <div className="ent-employees-page">
      {/* 简化英雄区 - 180px 高 */}
      <div className="ent-emp-hero">
        <div className="ent-emp-hero-text">
          <span className="ent-emp-eyebrow">SILICON EMPLOYEES</span>
          <h1 className="ent-emp-hero-title">
            硅基员工<em>目录</em>
          </h1>
          <p className="ent-emp-hero-stats">
            共 {overview.totalEmployees} 名员工，{overview.availableToMe} 名分配给你
          </p>
        </div>
        <div className="ent-emp-hero-image" aria-hidden="true">
          {/* 团队协作照片占位 480x180px */}
          <div className="ent-emp-hero-placeholder" />
        </div>
      </div>

      {/* 二级过滤栏 - 48px 高 */}
      <div className="ent-emp-filters">
        <div className="ent-segment" role="tablist" aria-label="员工范围">
          {SCOPES.map(item => (
            <button key={item.id} type="button" role="tab" aria-selected={scope === item.id} className={scope === item.id ? 'active' : undefined} onClick={() => setScope(item.id)}>
              {item.label}
            </button>
          ))}
        </div>

        <select className="ent-select auto" value={availability} onChange={event => setAvailability(event.target.value as '' | EmployeeAvailability)} aria-label="按可用状态筛选">
          <option value="">全部状态</option>
          {(Object.keys(EMPLOYEE_AVAILABILITY) as EmployeeAvailability[]).map(key => (
            <option key={key} value={key}>{EMPLOYEE_AVAILABILITY[key].label}</option>
          ))}
        </select>

        <span className="ent-ask-spacer" />

        <label className="ent-find compact">
          <Search size={14} aria-hidden />
          <input type="search" value={search} placeholder="搜索员工姓名或擅长" aria-label="搜索员工" onChange={event => setSearch(event.target.value)} />
        </label>

        <div className="ent-segment icon" role="group" aria-label="展示方式">
          <button type="button" className={dense ? undefined : 'active'} onClick={() => setDense(false)} aria-label="卡片视图" title="卡片视图"><LayoutGrid size={14} aria-hidden /></button>
          <button type="button" className={dense ? 'active' : undefined} onClick={() => setDense(true)} aria-label="紧凑列表" title="紧凑列表"><List size={14} aria-hidden /></button>
        </div>
      </div>

      <div className="ent-employees-content">
        <p className="ent-result-note">
          共 {list.length} 名员工{scope === 'all' ? '（灰色卡片表示尚未分配给你，只能查看介绍）' : ''}
        </p>

      {!list.length ? (
        <Empty title="没有符合条件的员工">换一个筛选条件，或者查看企业全部员工。</Empty>
      ) : dense ? (
        // 紧凑列表：当列表较长时使用虚拟滚动优化性能
        list.length > 20 ? (
          <VirtualList
            items={list}
            height="600px"
            estimateSize={60}
            className="ent-emp-list"
            renderItem={(employee) => (
              <EmployeeCard
                key={employee.id}
                employee={employee}
                compact
                onOpen={open}
                onChat={employee.assignedToMe ? id => open(id) : undefined}
              />
            )}
          />
        ) : (
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
        )
      ) : (
        // 卡片网格：当卡片较多时使用虚拟网格优化性能
        list.length > 12 ? (
          <VirtualGrid
            items={list}
            height="800px"
            columns={3}
            estimateSize={200}
            className="ent-emp-grid"
            renderItem={(employee) => (
              <EmployeeCard
                key={employee.id}
                employee={employee}
                onOpen={open}
                onChat={employee.assignedToMe ? id => open(id) : undefined}
              />
            )}
          />
        ) : (
          <div className="ent-emp-grid">
            {list.map(employee => (
              <EmployeeCard
                key={employee.id}
                employee={employee}
                onOpen={open}
                onChat={employee.assignedToMe ? id => open(id) : undefined}
              />
            ))}
          </div>
        )
      )}
      </div>
    </div>
  );
}
