/**
 * src/pages/InstanceSelectPage.tsx — 实例选择页面
 *
 * 功能:
 *   - 展示用户可用的 AI 实例列表
 *   - 记住上次选择的实例（高亮显示）
 *   - 选择实例后由主进程启动带自动刷新令牌的会话
 *   - 跳转到聊天页面
 */

import { useEffect, useState } from 'react';
import { Button } from '../components/ui/Button';
import type { EmployeeInstanceSnapshot } from '../shared/types';

type Instance = EmployeeInstanceSnapshot;

interface InstanceSelectPageProps {
  onInstanceSelected: (instanceId: string, instanceName: string, instances: EmployeeInstanceSnapshot[]) => Promise<void>;
  onLogout: () => void;
}

export function InstanceSelectPage({ onInstanceSelected, onLogout }: InstanceSelectPageProps) {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // 加载实例列表
  useEffect(() => {
    loadInstances();
    // 从 localStorage 读取上次选择的实例
    const saved = localStorage.getItem('lastSelectedInstanceId');
    if (saved) {
      setLastSelectedId(saved);
    }
  }, []);

  const loadInstances = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await window.electronAPI.getInstances();

      if (result.success && result.data) {
        setInstances(result.data);

        if (result.data.length === 1) {
          await handleConfirm(result.data[0], result.data);
          return;
        }

        const saved = localStorage.getItem('lastSelectedInstanceId');
        if (saved && result.data.some(instance => instance.id === saved)) {
          setSelectedId(saved);
        }
      } else {
        setError(result.error?.message || '获取实例列表失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (instance: Instance, availableInstances = instances) => {
    setConfirming(true);
    setError(null);

    try {
      await onInstanceSelected(instance.id, instance.name, availableInstances);
      localStorage.setItem('lastSelectedInstanceId', instance.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setConfirming(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">加载实例列表...</p>
        </div>
      </div>
    );
  }

  if (error && instances.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8 max-w-md w-full">
          <h2 className="text-xl font-semibold text-red-600 dark:text-red-400 mb-4">加载失败</h2>
          <p className="text-gray-700 dark:text-gray-300 mb-6">{error}</p>
          <div className="flex gap-3">
            <Button onClick={loadInstances} variant="primary">重试</Button>
            <Button onClick={onLogout} variant="secondary">退出登录</Button>
          </div>
        </div>
      </div>
    );
  }

  if (instances.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8 max-w-md w-full text-center">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">暂无可用实例</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            您的账号下没有可用的 AI 实例。请联系管理员分配实例权限。
          </p>
          <Button onClick={onLogout} variant="secondary">退出登录</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">选择 AI 实例</h1>
            <p className="text-gray-600 dark:text-gray-400 mt-2">
              共 {instances.length} 个可用实例
            </p>
          </div>
          <Button onClick={onLogout} variant="ghost">退出登录</Button>
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 mb-6">
            <p className="text-red-700 dark:text-red-400">{error}</p>
          </div>
        )}

        {/* Instance List */}
        <div className="space-y-3">
          {instances.map((instance) => {
            const isSelected = selectedId === instance.id;
            const isLastSelected = lastSelectedId === instance.id;

            return (
              <button
                key={instance.id}
                onClick={() => setSelectedId(instance.id)}
                disabled={confirming}
                className={`
                  w-full text-left p-5 rounded-lg border-2 transition-all
                  ${isSelected
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : isLastSelected
                      ? 'border-blue-300 dark:border-blue-700 bg-white dark:bg-gray-800 hover:border-blue-400'
                      : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-gray-300'
                  }
                `}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                        {instance.name}
                      </h3>
                      {isLastSelected && (
                        <span className="text-xs bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded">
                          上次选择
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">
                      模板: {instance.template.name}
                    </p>
                    {instance.department && (
                      <p className="text-sm text-gray-500 dark:text-gray-500">
                        部门: {instance.department.name}
                      </p>
                    )}
                  </div>
                  <div className={`
                    w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors
                    ${isSelected
                      ? 'border-blue-500 bg-blue-500'
                      : 'border-gray-300 dark:border-gray-600'
                    }
                  `}>
                    {isSelected && (
                      <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Confirm Button */}
        <div className="mt-8">
          <Button
            onClick={() => {
              const instance = instances.find(item => item.id === selectedId);
              if (instance) void handleConfirm(instance);
            }}
            disabled={!selectedId || confirming}
            variant="primary"
            className="w-full"
          >
            {confirming ? '正在连接...' : '确认选择'}
          </Button>
        </div>
      </div>
    </div>
  );
}
