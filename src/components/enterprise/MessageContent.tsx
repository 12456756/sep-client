import { Children, isValidElement, memo, useEffect, useRef, useState, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const COPY_FEEDBACK_MS = 2500;

interface MessageContentProps {
  content: string;
}

interface CopyTextProps {
  text: string;
  label: string;
}

function CopyText({ text, label }: CopyTextProps) {
  const [feedback, setFeedback] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback('已复制');
    } catch {
      setFeedback('复制失败，请手动选择文本');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFeedback(''), COPY_FEEDBACK_MS);
  };
  return <span className="ent-message-copy">
    <button type="button" className="ent-btn sm" onClick={() => void copy()}>{label}</button>
    <span role="status">{feedback}</span>
  </span>;
}

function textOf(children: ReactNode): string {
  return Children.toArray(children).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    return isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : '';
  }).join('');
}

// 不执行原始 HTML，不加载远程图片；模型输出的链接仅允许网页协议。
const components: Components = {
  a: ({ href, children }) => href
    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>,
  img: ({ alt }) => <span className="ent-hint">[图片：{alt || '未加载'}]</span>,
  table: ({ children }) => <div className="ent-markdown-table" tabIndex={0} role="region" aria-label="表格，可横向滚动"><table>{children}</table></div>,
  pre: ({ children }) => <div className="ent-code-block">
    <CopyText text={textOf(children)} label="复制代码" />
    <pre tabIndex={0}>{children}</pre>
  </div>,
};
const remarkPlugins = [remarkGfm];
const safeUrl = (url: string): string => /^https?:\/\//i.test(url) ? url : '';

export const MessageContent = memo(function MessageContent({ content }: MessageContentProps) {
  return <>
    <div className="ent-markdown">
      <Markdown skipHtml remarkPlugins={remarkPlugins} components={components} urlTransform={safeUrl}>{content}</Markdown>
    </div>
    <CopyText text={content} label="复制回答" />
  </>;
});
