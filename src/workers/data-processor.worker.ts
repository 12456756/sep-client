/**
 * 数据处理 Worker
 * 处理员工列表的排序、过滤和搜索等 CPU 密集型操作
 */

import type { WorkerMessage, WorkerResponse } from './WorkerManager';

// 员工数据类型
interface Employee {
  id: string;
  name: string;
  department: string;
  position: string;
  status: string;
  joinDate: string;
  email?: string;
  phone?: string;
  tags?: string[];
  [key: string]: unknown;
}

// 排序配置
interface SortConfig {
  field: string;
  order: 'asc' | 'desc';
}

// 过滤配置
interface FilterConfig {
  field: string;
  operator: 'eq' | 'ne' | 'contains' | 'startsWith' | 'in';
  value: unknown;
}

// 搜索配置
interface SearchConfig {
  query: string;
  fields: string[];
  caseSensitive?: boolean;
}

// Worker 任务类型
interface SortTaskPayload {
  data: Employee[];
  sort: SortConfig;
}

interface FilterTaskPayload {
  data: Employee[];
  filters: FilterConfig[];
}

interface SearchTaskPayload {
  data: Employee[];
  search: SearchConfig;
}

interface ProcessTaskPayload {
  data: Employee[];
  sort?: SortConfig;
  filters?: FilterConfig[];
  search?: SearchConfig;
}

// 排序函数
function sortData(data: Employee[], sort: SortConfig): Employee[] {
  const { field, order } = sort;

  return [...data].sort((a, b) => {
    const aVal = a[field];
    const bVal = b[field];

    if (aVal === bVal) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;

    let comparison = 0;
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      comparison = aVal.localeCompare(bVal, 'zh-CN');
    } else if (typeof aVal === 'number' && typeof bVal === 'number') {
      comparison = aVal - bVal;
    } else {
      comparison = String(aVal).localeCompare(String(bVal), 'zh-CN');
    }

    return order === 'asc' ? comparison : -comparison;
  });
}

// 过滤函数
function filterData(data: Employee[], filters: FilterConfig[]): Employee[] {
  return data.filter((item) => {
    return filters.every((filter) => {
      const value = item[filter.field];

      switch (filter.operator) {
        case 'eq':
          return value === filter.value;
        case 'ne':
          return value !== filter.value;
        case 'contains':
          return String(value).toLowerCase().includes(String(filter.value).toLowerCase());
        case 'startsWith':
          return String(value).toLowerCase().startsWith(String(filter.value).toLowerCase());
        case 'in':
          return Array.isArray(filter.value) && filter.value.includes(value);
        default:
          return true;
      }
    });
  });
}

// 搜索函数
function searchData(data: Employee[], search: SearchConfig): Employee[] {
  const { query, fields, caseSensitive = false } = search;

  if (!query.trim()) return data;

  const searchQuery = caseSensitive ? query : query.toLowerCase();

  return data.filter((item) => {
    return fields.some((field) => {
      const value = item[field];
      if (value == null) return false;

      const stringValue = caseSensitive ? String(value) : String(value).toLowerCase();
      return stringValue.includes(searchQuery);
    });
  });
}

// 综合处理函数
function processData(payload: ProcessTaskPayload): Employee[] {
  let result = payload.data;

  // 1. 搜索
  if (payload.search) {
    result = searchData(result, payload.search);
  }

  // 2. 过滤
  if (payload.filters && payload.filters.length > 0) {
    result = filterData(result, payload.filters);
  }

  // 3. 排序
  if (payload.sort) {
    result = sortData(result, payload.sort);
  }

  return result;
}

// Worker 消息处理
self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const { id, type, payload } = event.data;

  try {
    let result: unknown;

    switch (type) {
      case 'sort':
        result = sortData(
          (payload as SortTaskPayload).data,
          (payload as SortTaskPayload).sort
        );
        break;

      case 'filter':
        result = filterData(
          (payload as FilterTaskPayload).data,
          (payload as FilterTaskPayload).filters
        );
        break;

      case 'search':
        result = searchData(
          (payload as SearchTaskPayload).data,
          (payload as SearchTaskPayload).search
        );
        break;

      case 'process':
        result = processData(payload as ProcessTaskPayload);
        break;

      default:
        throw new Error(`未知的任务类型: ${type}`);
    }

    const response: WorkerResponse = {
      id,
      success: true,
      data: result,
    };

    self.postMessage(response);
  } catch (error) {
    const response: WorkerResponse = {
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };

    self.postMessage(response);
  }
};

// 类型导出（仅用于类型检查，不会在 Worker 中使用）
export type {
  Employee,
  SortConfig,
  FilterConfig,
  SearchConfig,
  SortTaskPayload,
  FilterTaskPayload,
  SearchTaskPayload,
  ProcessTaskPayload,
};
