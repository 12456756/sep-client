import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

interface CreateTaskDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: { title: string; prompt: string; workDir: string }) => void;
}

export function CreateTaskDialog({ isOpen, onClose, onSubmit }: CreateTaskDialogProps) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [workDir, setWorkDir] = useState('');
  const [isSelectingDir, setIsSelectingDir] = useState(false);

  const handleSelectDirectory = async () => {
    setIsSelectingDir(true);
    try {
      const result = await window.electronAPI.selectDirectory();
      if (result.success && result.path) {
        setWorkDir(result.path);
      }
    } catch (error) {
      console.error('Failed to select directory:', error);
    } finally {
      setIsSelectingDir(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !prompt.trim()) return;

    onSubmit({
      title: title.trim(),
      prompt: prompt.trim(),
      workDir: workDir.trim() || process.cwd(),
    });

    // Reset form
    setTitle('');
    setPrompt('');
    setWorkDir('');
    onClose();
  };

  const handleCancel = () => {
    setTitle('');
    setPrompt('');
    setWorkDir('');
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">创建新任务</h2>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Title */}
          <div>
            <label htmlFor="task-title" className="block text-sm font-medium text-gray-700 mb-1">
              任务标题 *
            </label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：实现用户登录功能"
              className="w-full"
              autoFocus
            />
          </div>

          {/* Prompt */}
          <div>
            <label htmlFor="task-prompt" className="block text-sm font-medium text-gray-700 mb-1">
              任务描述 *
            </label>
            <textarea
              id="task-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="详细描述你希望 AI 员工完成的任务..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              rows={6}
            />
          </div>

          {/* Work Directory */}
          <div>
            <label htmlFor="task-workdir" className="block text-sm font-medium text-gray-700 mb-1">
              工作目录
            </label>
            <div className="flex gap-2">
              <Input
                id="task-workdir"
                value={workDir}
                onChange={(e) => setWorkDir(e.target.value)}
                placeholder="留空则使用当前目录"
                className="flex-1"
              />
              <Button
                type="button"
                onClick={handleSelectDirectory}
                disabled={isSelectingDir}
                variant="secondary"
              >
                {isSelectingDir ? '选择中...' : '浏览...'}
              </Button>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              AI 员工只能在此目录及其子目录下操作文件
            </p>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" onClick={handleCancel} variant="secondary">
              取消
            </Button>
            <Button type="submit" disabled={!title.trim() || !prompt.trim()}>
              创建任务
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
