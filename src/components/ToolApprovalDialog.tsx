/**
 * src/components/ToolApprovalDialog.tsx — 工具审批对话框
 *
 * 功能:
 *   - 显示 AI 请求执行的工具名称和参数
 *   - 允许用户批准或拒绝执行
 *   - 60 秒倒计时，超时自动拒绝
 *
 * 视觉:
 *   企业外壳（ent-*）那套暖陶土体系，不是 Tailwind。倒计时做成一枚会收紧的环，
 *   标题用 Fraunces 衬线，风险提示走琥珀，允许/拒绝是并排两颗实心键。默认焦点落在
 *   「拒绝」上、Esc 也走拒绝 —— 误触应当落在安全的那一边。
 */

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AlertTriangle, Check, ShieldCheck, Wrench, X } from 'lucide-react';

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

/** 剩余秒数低于这个阈值时，倒计时环与秒数转为绛红（urgent）。 */
const URGENT_BELOW_SECONDS = 10;

/** 倒计时环几何：r=26、stroke-width=3，画在 56×56 的 viewBox 里。 */
const RING_RADIUS = 26;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 高风险工具的说明 */
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

/** 格式化输入内容以供显示。 */
function formatInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && input !== null) {
    return JSON.stringify(input, null, 2);
  }
  return String(input);
}

export function ToolApprovalDialog({ request, onApprove, onDeny }: ToolApprovalDialogProps) {
  const [countdown, setCountdown] = useState(TIMEOUT_SECONDS);
  const denyButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;

    // 收到新请求时重置倒计时。
    setCountdown(TIMEOUT_SECONDS);

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          onDeny(); // 超时后自动拒绝。
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [request, onDeny]);

  useEffect(() => {
    if (request) denyButtonRef.current?.focus();
  }, [request]);

  if (!request) return null;

  const toolInfo = TOOL_DESCRIPTIONS[request.toolName] || {
    title: `未知工具: ${request.toolName}`,
    description: 'AI 请求执行一个未知的工具',
    risk: '未知风险，建议拒绝',
  };

  const inputDisplay = formatInput(request.input);
  const shouldTruncate = inputDisplay.length > 500;
  const displayText = shouldTruncate ? `${inputDisplay.slice(0, 500)}\n\n... (已截断)` : inputDisplay;

  const isUrgent = countdown < URGENT_BELOW_SECONDS;
  const ringOffset = RING_CIRCUMFERENCE * (1 - countdown / TIMEOUT_SECONDS);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onDeny();
    }
  };

  return (
    <div className="ent-approve-back" role="presentation">
      <div
        className="ent-approve"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tool-approval-title"
        aria-describedby="tool-approval-description"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <header className="ent-approve-head">
          <div className="ent-approve-head-text">
            <h2 id="tool-approval-title" className="ent-approve-title">
              <ShieldCheck size={20} aria-hidden />
              工具执行授权
            </h2>
            <p id="tool-approval-description" className="ent-approve-desc">
              {toolInfo.description}
            </p>
          </div>

          {/* 倒计时环 + 自动拒绝说明 */}
          <div
            className={`ent-approve-count${isUrgent ? ' urgent' : ''}`}
            role="timer"
            aria-live="off"
            aria-label={`${countdown} 秒后自动拒绝`}
          >
            <div className="ent-approve-dial">
              <svg viewBox="0 0 56 56" width="56" height="56" aria-hidden>
                <circle className="ent-approve-track" cx="28" cy="28" r={RING_RADIUS} />
                <circle
                  className="ent-approve-ring"
                  cx="28"
                  cy="28"
                  r={RING_RADIUS}
                  strokeDasharray={RING_CIRCUMFERENCE}
                  strokeDashoffset={ringOffset}
                />
              </svg>
              <span className="ent-approve-secs">{countdown}</span>
            </div>
            <span className="ent-approve-auto">秒后自动拒绝</span>
          </div>
        </header>

        {/* Content */}
        <div className="ent-approve-body">
          {/* Risk Warning */}
          <div className="ent-approve-risk">
            <AlertTriangle size={18} aria-hidden />
            <div className="ent-approve-risk-text">
              <strong>风险提示</strong>
              <span>{toolInfo.risk}</span>
            </div>
          </div>

          {/* Tool Name */}
          <div className="ent-approve-field">
            <span className="ent-approve-label">工具名称</span>
            <span className="ent-approve-tool">
              <Wrench size={14} aria-hidden />
              {request.toolName}
            </span>
          </div>

          {/* Tool Parameters */}
          <div className="ent-approve-field">
            <span className="ent-approve-label">参数内容</span>
            <pre className="ent-approve-pre">{displayText}</pre>
          </div>
        </div>

        {/* Actions */}
        <footer className="ent-approve-foot">
          <div className="ent-approve-actions">
            <button
              ref={denyButtonRef}
              type="button"
              className="ent-btn lg"
              onClick={onDeny}
              aria-label="拒绝工具执行"
              title="拒绝工具执行"
            >
              <X size={16} aria-hidden />
              拒绝执行
            </button>
            <button
              type="button"
              className="ent-btn lg primary"
              onClick={onApprove}
              aria-label="允许工具执行"
              title="允许工具执行"
            >
              <Check size={16} aria-hidden />
              允许执行
            </button>
          </div>
          <p className="ent-approve-hint">仅在您确认操作安全的情况下点击「允许执行」</p>
        </footer>
      </div>
    </div>
  );
}
