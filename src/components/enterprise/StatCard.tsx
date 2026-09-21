/**
 * 统计卡片组件。用于首页展示公司员工总数、已分配员工等放大的统计信息。
 *
 * 设计特点：
 * - 较大的卡片（280-320px），视觉突出
 * - 清晰的数值展示
 * - Hover 时有阴影提升 + Y 轴上移效果
 * - 支持可选的副标题和图标
 */

import type { ReactNode } from 'react';

export interface StatCardProps {
  /** 卡片标题 */
  title: string;
  /** 主要数值 */
  value: number;
  /** 可选的副标题 */
  subtitle?: string;
  /** 可选的图标或 emoji */
  icon?: ReactNode;
  /** 卡片颜色主题：primary (陶土) | accent (暖金) | success (绿) | warning (琥珀) | danger (红) */
  color?: 'primary' | 'accent' | 'success' | 'warning' | 'danger';
  /** 点击回调 */
  onClick?: () => void;
  /** 自定义 className */
  className?: string;
}

/**
 * StatCard 组件
 *
 * 用法示例：
 * ```tsx
 * <StatCard
 *   title="公司员工总数"
 *   value={100}
 *   icon="👥"
 *   color="primary"
 *   onClick={() => navigate({ name: 'employees' })}
 * />
 * ```
 */
export function StatCard({
  title,
  value,
  subtitle,
  icon,
  color = 'primary',
  onClick,
  className,
}: StatCardProps) {
  return (
    <button
      type="button"
      className={`stat-card stat-card-${color}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      aria-label={`${title}${subtitle ? `，${subtitle}` : ''}：${value}`}
    >
      {icon && (
        <div className="stat-icon" aria-hidden>
          {icon}
        </div>
      )}

      <div className="stat-content">
        <div className="stat-value">{value}</div>
        <div className="stat-title">{title}</div>
        {subtitle && <div className="stat-subtitle">{subtitle}</div>}
      </div>
    </button>
  );
}
