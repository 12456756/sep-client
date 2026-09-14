/**
 * 内容区顶部那条 Header：当前位置 + 一句副标题 + 本页主操作。
 *
 * 它是一条白色横条（设计稿 56~64 高），底下一条极浅的线把它和内容区分开，
 * 并且永远在 —— 工作详情和安排工作不写标题（它们的第一行本身就是内容，
 * 再写一句栏目名只是重复导航已经点亮的入口），横条本身仍然要在，
 * 因为右边那颗铃铛是全局的，不能跟着页面一起消失。
 *
 * 这条横条同时是 Electron 的窗口拖拽区。右边固定让出一段给 Windows 的窗口按钮，
 * 留白在 enterprise.css 的 .ent-top 里。抬头不出现任何技术标识（任务 ID、会话、模型名）。
 */

import type { ReactNode } from 'react';

interface Props {
  /** 不给就只有一条空横条：这一页的标题写在页面内容里。 */
  title?: string;
  /** 标题下面那一行，说明「这一页现在是什么情况」。可以不给。 */
  subtitle?: string;
  /** 本页主操作，靠右对齐。 */
  actions?: ReactNode;
}

export function AppTopBar({ title, subtitle, actions }: Props) {
  return (
    <header className="ent-top electron-drag-region">
      {title ? (
        <div className="ent-top-head">
          <h1 className="ent-top-title">{title}</h1>
          {subtitle ? <span className="ent-top-sub">{subtitle}</span> : null}
        </div>
      ) : null}
      {actions ? <div className="ent-top-actions">{actions}</div> : null}
    </header>
  );
}


