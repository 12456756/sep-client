import React, { useState, useEffect } from 'react';
import { Task, TaskStatus } from '@/shared/task-types';
import { TaskCard } from '@/components/TaskCard';
import { CreateTaskDialog } from '@/components/CreateTaskDialog';
import { TaskDetailDrawer } from '@/components/TaskDetailDrawer';
import { Button } from '@/components/ui/Button';

interface TaskBoardPageProps {
  instanceName: string;
}

const statusGroups: { status: TaskStatus; title: string }[] = [
  { status: TaskStatus.PENDING, title: '待执行' },
  { status: TaskStatus.RUNNING, title: '执行中' },
  { status: TaskStatus.WAITING_APPROVAL, title: '等待审批' },
  { status: TaskStatus.COMPLETED, title: '已完成' },
  { status: TaskStatus.FAILED, title: '失败' },
];

export function TaskBoardPage({ instanceName }: TaskBoardPageProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Load tasks on mount
  useEffect(() => {
    loadTasks();
  }, []);

  // Subscribe to task updates
  useEffect(() => {
    const unsubscribe = window.electronAPI.onTaskUpdated((updatedTask: Task) => {
      setTasks((prev) =>
        prev.map((t) => (t.id === updatedTask.id ? updatedTask : t))
      );

      // Update selected task if it's the one being updated
      if (selectedTask?.id === updatedTask.id) {
        setSelectedTask(updatedTask);
      }
    });

    return unsubscribe;
  }, [selectedTask]);

  const loadTasks = async () => {
    setIsLoading(true);
    try {
      const result = await window.electronAPI.getAllTasks();
      if (result.success && result.tasks) {
        setTasks(result.tasks);
      }
    } catch (error) {
      console.error('Failed to load tasks:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateTask = async (data: { title: string; prompt: string; workDir: string }) => {
    try {
      const result = await window.electronAPI.createTask(data);
      if (result.success && result.task) {
        setTasks((prev) => [result.task!, ...prev]);

        // Auto-execute the task
        await window.electronAPI.executeTask(result.task!.id);
      }
    } catch (error) {
      console.error('Failed to create task:', error);
    }
  };

  const handleTaskClick = (task: Task) => {
    setSelectedTask(task);
  };

  const handleCloseDrawer = () => {
    setSelectedTask(null);
  };

  const getTasksByStatus = (status: TaskStatus): Task[] => {
    return tasks.filter((t) => t.status === status);
  };

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">任务看板</h1>
            <p className="text-sm text-gray-600 mt-1">
              AI 员工：{instanceName}
            </p>
          </div>
          <Button onClick={() => setIsCreateDialogOpen(true)}>
            ➕ 新建任务
          </Button>
        </div>
      </header>

      {/* Task Board - Trello Style */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        <div className="h-full flex gap-4 p-6 min-w-max">
          {statusGroups.map(({ status, title }) => {
            const groupTasks = getTasksByStatus(status);
            return (
              <div
                key={status}
                className="flex-shrink-0 w-80 bg-gray-100 rounded-lg p-4 flex flex-col"
              >
                {/* Column Header */}
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-semibold text-gray-900">{title}</h2>
                  <span className="bg-gray-200 text-gray-700 text-xs font-medium px-2 py-1 rounded">
                    {groupTasks.length}
                  </span>
                </div>

                {/* Task Cards */}
                <div className="flex-1 overflow-y-auto space-y-3">
                  {groupTasks.length === 0 ? (
                    <p className="text-sm text-gray-500 text-center py-8">暂无任务</p>
                  ) : (
                    groupTasks.map((task) => (
                      <TaskCard key={task.id} task={task} onClick={handleTaskClick} />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Create Task Dialog */}
      <CreateTaskDialog
        isOpen={isCreateDialogOpen}
        onClose={() => setIsCreateDialogOpen(false)}
        onSubmit={handleCreateTask}
      />

      {/* Task Detail Drawer */}
      {selectedTask && (
        <TaskDetailDrawer task={selectedTask} onClose={handleCloseDrawer} />
      )}
    </div>
  );
}
