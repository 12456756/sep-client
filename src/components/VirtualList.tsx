/**
 * 虚拟滚动列表组件
 * 用于优化大量数据列表的渲染性能
 */

import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

interface VirtualListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  estimateSize?: number;
  overscan?: number;
  className?: string;
  height?: string;
  gap?: number;
}

/**
 * 虚拟滚动列表
 * 只渲染可见区域的项目，大幅提升长列表性能
 *
 * @example
 * <VirtualList
 *   items={employees}
 *   estimateSize={80}
 *   renderItem={(employee) => <EmployeeCard employee={employee} />}
 * />
 */
export function VirtualList<T>({
  items,
  renderItem,
  estimateSize = 80,
  overscan = 5,
  className = '',
  height = '600px',
  gap = 8,
}: VirtualListProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan,
    gap,
  });

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className={`overflow-auto ${className}`}
      style={{ height }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualItem) => (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            {renderItem(items[virtualItem.index], virtualItem.index)}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 虚拟滚动网格
 * 用于展示大量卡片/网格项
 */
interface VirtualGridProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  columns?: number;
  estimateSize?: number;
  gap?: number;
  className?: string;
  height?: string;
}

export function VirtualGrid<T>({
  items,
  renderItem,
  columns = 3,
  estimateSize = 200,
  gap = 16,
  className = '',
  height = '600px',
}: VirtualGridProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [responsiveColumns, setResponsiveColumns] = useState(columns);

  useEffect(() => {
    const updateColumns = () => {
      const width = window.innerWidth;
      setResponsiveColumns(width <= 640 ? 1 : width <= 960 ? Math.min(columns, 2) : columns);
    };
    updateColumns();
    window.addEventListener('resize', updateColumns);
    return () => window.removeEventListener('resize', updateColumns);
  }, [columns]);

  // 将一维数组转换为行
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += responsiveColumns) {
    rows.push(items.slice(i, i + responsiveColumns));
  }

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan: 2,
    gap,
  });

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className={`overflow-auto ${className}`}
      style={{ height }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualRow) => (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <div
              className="grid gap-4"
              style={{
                gridTemplateColumns: `repeat(${responsiveColumns}, minmax(0, 1fr))`,
              }}
            >
              {rows[virtualRow.index].map((item: T, colIndex: number) => (
                <div key={virtualRow.index * responsiveColumns + colIndex}>
                  {renderItem(item, virtualRow.index * responsiveColumns + colIndex)}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
