/**
 * Web Worker 集成示例
 * 演示如何在 EmployeesPage 中使用 useDataProcessor
 */

import { useDataProcessor } from '@/workers/useWorker';
import { useEffect, useState } from 'react';

// 示例员工数据类型
interface Employee extends Record<string, unknown> {
  id: string;
  name: string;
  department: string;
  position: string;
  status: string;
  joinDate: string;
  email?: string;
  phone?: string;
}

export function EmployeesPageExample() {
  const [rawData] = useState<Employee[]>([]);
  const [processedData, setProcessedData] = useState<Employee[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<string>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const { process, isLoading, error } = useDataProcessor<Employee>();

  // 当搜索、排序条件变化时，使用 Worker 处理数据
  useEffect(() => {
    if (rawData.length === 0) return;

    const processDataAsync = async () => {
      try {
        const result = await process(rawData, {
          search: searchQuery
            ? {
                query: searchQuery,
                fields: ['name', 'department', 'position', 'email'],
                caseSensitive: false,
              }
            : undefined,
          sort: {
            field: sortField,
            order: sortOrder,
          },
        });
        setProcessedData(result);
      } catch (err) {
        console.error('数据处理失败:', err);
      }
    };

    processDataAsync();
  }, [rawData, searchQuery, sortField, sortOrder, process]);

  return (
    <div className="p-4">
      <div className="mb-4 flex gap-4">
        <input
          type="text"
          placeholder="搜索员工..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 px-3 py-2 border rounded"
        />

        <select
          value={sortField}
          onChange={(e) => setSortField(e.target.value)}
          className="px-3 py-2 border rounded"
        >
          <option value="name">姓名</option>
          <option value="department">部门</option>
          <option value="position">职位</option>
          <option value="joinDate">入职日期</option>
        </select>

        <button
          onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
          className="px-4 py-2 bg-blue-500 text-white rounded"
        >
          {sortOrder === 'asc' ? '升序 ↑' : '降序 ↓'}
        </button>
      </div>

      {isLoading && <div className="text-gray-500">处理中...</div>}
      {error && <div className="text-red-500">错误: {error.message}</div>}

      <div className="space-y-2">
        {processedData.map((employee) => (
          <div key={employee.id} className="p-4 border rounded">
            <div className="font-bold">{employee.name}</div>
            <div className="text-sm text-gray-600">
              {employee.department} - {employee.position}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 性能对比示例
export function PerformanceComparisonExample() {
  const [jsTime, setJsTime] = useState<number>(0);
  const [workerTime, setWorkerTime] = useState<number>(0);

  const { process } = useDataProcessor<Employee>();

  // 生成测试数据
  const generateTestData = (count: number): Employee[] => {
    return Array.from({ length: count }, (_, i) => ({
      id: `emp-${i}`,
      name: `员工${i}`,
      department: ['技术部', '产品部', '运营部'][i % 3],
      position: ['工程师', '经理', '总监'][i % 3],
      status: ['在职', '离职'][i % 2],
      joinDate: new Date(2020 + (i % 5), i % 12, 1).toISOString(),
    }));
  };

  const runComparison = async () => {
    const testData = generateTestData(10000);

    // 1. JavaScript 主线程处理
    const jsStart = performance.now();
    testData
      .filter((e) => e.name.includes('1'))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const jsEnd = performance.now();
    setJsTime(jsEnd - jsStart);

    // 2. Web Worker 处理
    const workerStart = performance.now();
    await process(testData, {
      search: { query: '1', fields: ['name'] },
      sort: { field: 'name', order: 'asc' },
    });
    const workerEnd = performance.now();
    setWorkerTime(workerEnd - workerStart);

    console.log('JavaScript 主线程:', jsTime, 'ms');
    console.log('Web Worker:', workerTime, 'ms');
    console.log('性能提升:', ((jsTime / workerTime - 1) * 100).toFixed(1), '%');
  };

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold mb-4">性能对比测试</h2>

      <button
        onClick={runComparison}
        className="px-4 py-2 bg-green-500 text-white rounded mb-4"
      >
        运行测试 (10,000 条数据)
      </button>

      {jsTime > 0 && (
        <div className="space-y-2">
          <div className="p-3 bg-gray-100 rounded">
            <div className="font-bold">JavaScript 主线程</div>
            <div className="text-2xl">{jsTime.toFixed(2)} ms</div>
          </div>

          <div className="p-3 bg-green-100 rounded">
            <div className="font-bold">Web Worker</div>
            <div className="text-2xl">{workerTime.toFixed(2)} ms</div>
          </div>

          <div className="p-3 bg-blue-100 rounded">
            <div className="font-bold">性能提升</div>
            <div className="text-2xl">
              {((jsTime / workerTime - 1) * 100).toFixed(1)}%
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
