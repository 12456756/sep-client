/**
 * 骨架屏组件 - 用于加载状态的占位显示
 */

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = '' }: SkeletonProps) {
  return (
    <div
      className={`animate-pulse bg-gray-200 dark:bg-gray-700 rounded ${className}`}
      aria-hidden="true"
    />
  );
}

/**
 * 员工卡片骨架屏
 */
export function EmployeeCardSkeleton() {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm">
      <div className="flex items-center gap-3">
        {/* 头像 */}
        <Skeleton className="w-12 h-12 rounded-full flex-shrink-0" />

        <div className="flex-1 space-y-2">
          {/* 名称 */}
          <Skeleton className="h-4 w-32" />
          {/* 职位 */}
          <Skeleton className="h-3 w-24" />
        </div>

        {/* 状态指示器 */}
        <Skeleton className="w-16 h-6 rounded-full" />
      </div>

      {/* 描述 */}
      <div className="mt-3 space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    </div>
  );
}

/**
 * 员工列表骨架屏
 */
export function EmployeeListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <EmployeeCardSkeleton key={i} />
      ))}
    </div>
  );
}

/**
 * 工作区卡片骨架屏
 */
export function WorkspaceCardSkeleton() {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-sm">
      <div className="flex items-start justify-between mb-4">
        <div className="space-y-2 flex-1">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-32" />
        </div>
        <Skeleton className="w-8 h-8 rounded" />
      </div>

      <div className="space-y-3">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-4/6" />
      </div>

      <div className="mt-4 flex gap-2">
        <Skeleton className="h-9 flex-1 rounded-lg" />
        <Skeleton className="h-9 flex-1 rounded-lg" />
      </div>
    </div>
  );
}

/**
 * 页面加载骨架屏
 */
export function PageLoadingSkeleton() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      {/* 顶部导航栏 */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4 mb-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <div className="flex gap-3">
            <Skeleton className="h-10 w-24 rounded-lg" />
            <Skeleton className="h-10 w-10 rounded-full" />
          </div>
        </div>
      </div>

      {/* 主要内容区域 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <WorkspaceCardSkeleton />
          <WorkspaceCardSkeleton />
        </div>

        <div className="space-y-4">
          <EmployeeListSkeleton count={3} />
        </div>
      </div>
    </div>
  );
}

/**
 * 通用加载指示器
 */
export function LoadingSpinner({ size = 'md', className = '' }: { size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-8 h-8',
    lg: 'w-12 h-12',
  };

  return (
    <div className={`${sizeClasses[size]} ${className}`}>
      <svg
        className="animate-spin text-blue-600"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
    </div>
  );
}
