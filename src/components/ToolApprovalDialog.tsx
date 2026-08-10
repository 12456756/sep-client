/**
 * src/components/ToolApprovalDialog.tsx — 工具审批对话框
 *
 * 功能:
 *   - 显示 AI 请求执行的工具名称和参数
 *   - 允许用户批准或拒绝执行
 *   - 60 秒倒计时，超时自动拒绝
 */

import { useEffect, useState } from 'react';
import { Button } from './ui/Button';

interface ToolApprovalRequest {
  toolName: string;
  input: unknown;
}

interface ToolApprovalDialogProps {
  request: ToolApprovalRequest | null;
  onApprove: () => void;
  onDeny: () => void;
}

const TIMEOUT_SECONDS = 60;

// 高风险工具的说明
const TOOL_DESCRIPTIONS: Record<string, { title: string; description: string; risk: string }> = {
  bash: {
    title: 'Shell 命令执行',
    description: 'AI 请求在您的系统上执行 Shell 命令',
    risk: '可能修改文件、安装软件或访问系统资源',
  },
  write: {
    title: '创建/覆写文件',
    description: 'AI 请求创建新文件或覆盖现有文件',
    risk: '可能覆盖重要文件导致数据丢失',
  },
  edit: {
    title: '编辑文件',
    description: 'AI 请求修改现有文件内容',
    risk: '可能修改代码或配置文件',
  },
};

export function ToolApprovalDialog({ request, onApprove, onDeny }: ToolApprovalDialogProps) {
  const [countdown, setCountdown] = useState(TIMEOUT_SECONDS);

  useEffect(() => {
    if (!request) return;

    // Reset countdown when new request comes
    setCountdown(TIMEOUT_SECONDS);

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          onDeny(); // Auto-deny on timeout
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [request, onDeny]);

  if (!request) return null;

  const toolInfo = TOOL_DESCRIPTIONS[request.toolName] || {
    title: `未知工具: ${request.toolName}`,
    description: 'AI 请求执行一个未知的工具',
    risk: '未知风险，建议拒绝',
  };

  // Format input for display
  const formatInput = (input: unknown): string => {
    if (typeof input === 'string') return input;
    if (typeof input === 'object' && input !== null) {
      return JSON.stringify(input, null, 2);
    }
    return String(input);
  };

  const inputDisplay = formatInput(request.input);
  const shouldTruncate = inputDisplay.length > 500;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                🔐 工具执行授权
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {toolInfo.description}
              </p>
            </div>
            <div className="flex items-center gap-2 ml-4">
              <div className="text-right">
                <div className="text-2xl font-mono font-bold text-orange-600 dark:text-orange-400">
                  {countdown}s
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-500">
                  自动拒绝
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {/* Risk Warning */}
          <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg p-4 mb-4">
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-orange-600 dark:text-orange-400 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <div>
                <p className="text-sm font-medium text-orange-800 dark:text-orange-300">
                  ⚠️ 风险提示
                </p>
                <p className="text-sm text-orange-700 dark:text-orange-400 mt-1">
                  {toolInfo.risk}
                </p>
              </div>
            </div>
          </div>

          {/* Tool Name */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              工具名称
            </label>
            <div className="bg-gray-50 dark:bg-gray-900 px-4 py-2 rounded-md">
              <code className="text-blue-600 dark:text-blue-400 font-mono">
                {request.toolName}
              </code>
            </div>
          </div>

          {/* Tool Parameters */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              参数内容
            </label>
            <div className="bg-gray-50 dark:bg-gray-900 px-4 py-3 rounded-md overflow-x-auto">
              <pre className="text-sm text-gray-800 dark:text-gray-200 font-mono whitespace-pre-wrap break-words">
                {shouldTruncate ? inputDisplay.slice(0, 500) + '\n\n... (已截断)' : inputDisplay}
              </pre>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
          <div className="flex gap-3">
            <Button
              onClick={onDeny}
              variant="secondary"
              className="flex-1"
            >
              ❌ 拒绝执行
            </Button>
            <Button
              onClick={onApprove}
              variant="primary"
              className="flex-1"
            >
              ✅ 允许执行
            </Button>
          </div>
          <p className="text-xs text-center text-gray-500 dark:text-gray-500 mt-3">
            仅在您确认操作安全的情况下点击"允许执行"
          </p>
        </div>
      </div>
    </div>
  );
}
