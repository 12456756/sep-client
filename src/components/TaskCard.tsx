import React from 'react';
import { Task, TaskStatus } from '@/shared/task-types';

interface TaskCardProps {
  task: Task;
  onClick: (task: Task) => void;
}

const statusConfig: Record<TaskStatus, { label: string; bgColor: string; textColor: string }> = {
  [TaskStatus.PENDING]: { label: '待执行', bgColor: 'bg-gray-100', textColor: 'text-gray-700' },
  [TaskStatus.RUNNING]: { label: '执行中', bgColor: 'bg-blue-100', textColor: 'text-blue-700' },
  [TaskStatus.WAITING_APPROVAL]: { label: '等待审批', bgColor: 'bg-yellow-100', textColor: 'text-yellow-700' },
  [TaskStatus.PAUSED]: { label: '已暂停', bgColor: 'bg-orange-100', textColor: 'text-orange-700' },
  [TaskStatus.COMPLETED]: { label: '已完成', bgColor: 'bg-green-100', textColor: 'text-green-700' },
  [TaskStatus.FAILED]: { label: '失败', bgColor: 'bg-red-100', textColor: 'text-red-700' },
};

export function TaskCard({ task, onClick }: TaskCardProps) {
  const config = statusConfig[task.status];
  const createdTime = new Date(task.createdAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div
      onClick={() => onClick(task)}
      className="bg-white rounded-lg border border-gray-200 p-4 cursor-pointer hover:shadow-md transition-shadow"
    >
      {/* Status Badge */}
      <div className="flex items-center justify-between mb-2">
        <span className={`px-2 py-1 rounded text-xs font-medium ${config.bgColor} ${config.textColor}`}>
          {config.label}
        </span>
        <span className="text-xs text-gray-500">{createdTime}</span>
      </div>

      {/* Title */}
      <h3 className="font-medium text-gray-900 mb-1 line-clamp-2">{task.title}</h3>

      {/* Work Directory - Optional */}
      {task.workDir && (
        <p className="text-xs text-gray-500 truncate" title={task.workDir}>
          📁 {task.workDir}
        </p>
      )}

      {/* File Count - Optional */}
      {task.files.length > 0 && (
        <div className="mt-2 text-xs text-gray-600">
          📄 {task.files.length} 个文件
        </div>
      )}

      {/* Running Indicator */}
      {task.status === TaskStatus.RUNNING && (
        <div className="mt-2 flex items-center text-xs text-blue-600">
          <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-blue-600 mr-1"></div>
          执行中...
        </div>
      )}

      {/* Error Preview */}
      {task.status === TaskStatus.FAILED && task.error && (
        <div className="mt-2 text-xs text-red-600 line-clamp-1">
          ⚠️ {task.error}
        </div>
      )}
    </div>
  );
}
