import React, { useState } from 'react';
import { Task, TaskStatus, TaskLogLevel } from '@/shared/task-types';
import { Button } from '@/components/ui/Button';

interface TaskDetailDrawerProps {
  task: Task;
  onClose: () => void;
}

const logLevelConfig: Record<TaskLogLevel, { icon: string; color: string }> = {
  [TaskLogLevel.INFO]: { icon: 'ℹ️', color: 'text-blue-600' },
  [TaskLogLevel.WARNING]: { icon: '⚠️', color: 'text-yellow-600' },
  [TaskLogLevel.ERROR]: { icon: '❌', color: 'text-red-600' },
  [TaskLogLevel.SUCCESS]: { icon: '✅', color: 'text-green-600' },
};

export function TaskDetailDrawer({ task, onClose }: TaskDetailDrawerProps) {
  const [activeTab, setActiveTab] = useState<'logs' | 'files' | 'info'>('logs');

  const handlePause = async () => {
    if (task.status === TaskStatus.RUNNING) {
      await window.electronAPI.pauseTask(task.id);
    }
  };

  const handleCancel = async () => {
    await window.electronAPI.cancelTask(task.id);
  };

  const handleDelete = async () => {
    if (confirm('确定要删除这个任务吗？')) {
      await window.electronAPI.deleteTask(task.id);
      onClose();
    }
  };

  const canPause = task.status === TaskStatus.RUNNING;
  const canCancel = [TaskStatus.PENDING, TaskStatus.RUNNING, TaskStatus.PAUSED].includes(task.status);
  const canDelete = [TaskStatus.COMPLETED, TaskStatus.FAILED].includes(task.status);

  return (
    <div className="fixed inset-y-0 right-0 w-full max-w-2xl bg-white shadow-xl z-50 flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-semibold text-gray-900 truncate">{task.title}</h2>
          <p className="text-sm text-gray-500 mt-1">
            创建于 {new Date(task.createdAt).toLocaleString('zh-CN')}
          </p>
        </div>
        <button
          onClick={onClose}
          className="ml-4 text-gray-400 hover:text-gray-600 transition-colors"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 px-6">
        <div className="flex gap-6">
          {[
            { key: 'logs', label: '执行日志' },
            { key: 'files', label: `文件 (${task.files.length})` },
            { key: 'info', label: '任务信息' },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key as any)}
              className={`py-3 border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-blue-600 text-blue-600 font-medium'
                  : 'border-transparent text-gray-600 hover:text-gray-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === 'logs' && (
          <div className="space-y-2 font-mono text-sm">
            {task.logs.length === 0 ? (
              <p className="text-gray-500 text-center py-8">暂无日志</p>
            ) : (
              task.logs.map((log, index) => {
                const config = logLevelConfig[log.level];
                return (
                  <div key={index} className="flex gap-3 py-2 border-b border-gray-100">
                    <span className="flex-shrink-0">{config.icon}</span>
                    <span className="text-gray-500 flex-shrink-0">
                      {new Date(log.timestamp).toLocaleTimeString('zh-CN')}
                    </span>
                    <span className={config.color}>{log.message}</span>
                  </div>
                );
              })
            )}
          </div>
        )}

        {activeTab === 'files' && (
          <div className="space-y-1">
            {task.files.length === 0 ? (
              <p className="text-gray-500 text-center py-8">暂无关联文件</p>
            ) : (
              task.files.map((file, index) => (
                <div
                  key={index}
                  className="px-4 py-2 bg-gray-50 rounded hover:bg-gray-100 transition-colors"
                >
                  <code className="text-sm text-gray-800">{file}</code>
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'info' && (
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-1">任务描述</h3>
              <p className="text-sm text-gray-900 whitespace-pre-wrap bg-gray-50 p-4 rounded">
                {task.prompt}
              </p>
            </div>

            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-1">工作目录</h3>
              <code className="text-sm text-gray-900 bg-gray-50 px-3 py-2 rounded block">
                {task.workDir}
              </code>
            </div>

            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-1">状态</h3>
              <p className="text-sm text-gray-900">{task.status}</p>
            </div>

            {task.startedAt && (
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-1">开始时间</h3>
                <p className="text-sm text-gray-900">
                  {new Date(task.startedAt).toLocaleString('zh-CN')}
                </p>
              </div>
            )}

            {task.completedAt && (
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-1">完成时间</h3>
                <p className="text-sm text-gray-900">
                  {new Date(task.completedAt).toLocaleString('zh-CN')}
                </p>
              </div>
            )}

            {task.error && (
              <div>
                <h3 className="text-sm font-medium text-red-700 mb-1">错误信息</h3>
                <p className="text-sm text-red-900 bg-red-50 p-4 rounded">{task.error}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="px-6 py-4 border-t border-gray-200 flex gap-3">
        {canPause && (
          <Button onClick={handlePause} variant="secondary">
            暂停
          </Button>
        )}
        {canCancel && (
          <Button onClick={handleCancel} variant="secondary">
            取消
          </Button>
        )}
        {canDelete && (
          <Button onClick={handleDelete} variant="secondary">
            删除
          </Button>
        )}
        <div className="flex-1"></div>
        <Button onClick={onClose} variant="secondary">
          关闭
        </Button>
      </div>
    </div>
  );
}
