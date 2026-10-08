/** 对话式以消息为主，安排式保留工作报表；共用现有执行操作与数据源。 */

import {
  AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, Copy, LoaderCircle, MessageSquareText,
  PencilLine, RotateCcw, Share2, StopCircle, XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Empty, StepStateChip, WorkStatusChip } from '../../components/enterprise/atoms';
import { EmployeeFace } from '../../components/enterprise/EmployeeFace';
import { WorkPlanDrawer } from '../../components/enterprise/WorkPlanDrawer';
import { WorkConversation, WorkTalkDrawer } from '../../components/enterprise/WorkTalkDrawer';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { SiliconEmployee, WorkActivity, WorkItem } from '../../features/enterprise/types';
import { currentWorkOperation, processActivityLabel } from '../../features/enterprise/work-process';
import { usePrefersReducedMotion } from '../../features/enterprise/use-reduced-motion';
import { dayTimeText, durationText, stampText } from '../../features/enterprise/vocabulary';

interface Props {
  workspace: EnterpriseWorkspace;
  workId: string;
}

export function WorkDetailPage({ workspace, workId }: Props) {
  const work = workspace.works.find(item => item.id === workId);
  if (!work) {
    return (
      <div className="ent-page">
        <Empty title="找不到这项工作">它可能已经被删除。你可以在工作记录里查看其他工作。</Empty>
      </div>
    );
  }
  // 找不到工作时上面直接返回，所以下面这一层可以放心用 hook。
  // key 带上工作 id：改一版安排之后会跳到新工作，不重置的话抽屉会开着不动、内容换成新的那一项。
  return <Detail key={work.id} work={work} workspace={workspace} />;
}

/** 抬头右边和抽屉之间共用的一个状态：现在拉开的是哪个抽屉。 */
type Panel = 'talk' | 'plan' | null;

function Detail({ work, workspace }: { work: WorkItem; workspace: EnterpriseWorkspace }) {
  const team = useTeam(work, workspace);
  const solo = team.length <= 1;
  const isConversation = work.kind === 'conversation';
  const finished = work.status === 'completed';
  /** 这项工作已经不会自己往前走了。耗时、结束时间、能不能终止都按它算。 */
  const over = finished || work.status === 'paused' || work.status === 'failed';
  const percent = Math.round(work.progress);
  const doing = currentWorkOperation(work.status, work.activities);
  const next = work.steps.find(step => step.state === 'pending');
  const [panel, setPanel] = useState<Panel>(null);

  return (
    <div className="ent-page ent-wk">
      {/* 返回是真的返回：从首页员工抽屉进来的回首页，从工作记录进来的回工作记录。
          没有上一页时（比如刚安排完直接落在这一页）退到工作记录。 */}
      <button
        type="button"
        className="ent-wk-back"
        onClick={() => (workspace.canGoBack ? workspace.goBack() : workspace.navigate({ name: 'records' }))}
      >
        <ArrowLeft size={14} aria-hidden />
        返回
      </button>

      <div className="ent-wk-head">
        <h1>{work.title}</h1>
        <WorkStatusChip value={work.status} />
        <div className="ent-wk-head-actions">
          <ShareButton work={work} />
          {isConversation ? null : (
            <button
              type="button"
              className="ent-btn primary sm"
              title="同一批同事、同样的顺序，只改要完成什么。会开一项新工作，不影响这一项"
              onClick={() => setPanel('plan')}
            >
              <PencilLine size={14} aria-hidden />
              改一版安排
            </button>
          )}
        </div>
      </div>

      {/*
        信息条：员工、时间、耗时、进度压成一行。
        原先这些信息占了一整张卡片（约 150px），而内容只有四条短事实；
        压成一行后首屏腾出的高度正好给对话与产出。
      */}
      <div className="ent-wk-infobar">
        <span className="ent-wk-infobar-who">
          {solo ? (
            <>
              <EmployeeFace employee={team[0]} name={work.currentEmployeeName} size="sm" round />
              <span>
                <strong>{team[0]?.name ?? work.currentEmployeeName}</strong>
                <small>{team[0]?.roleName ?? '硅基员工'}</small>
              </span>
            </>
          ) : (
            <>
              {/*
                多人协作时头像叠成一串（最多露三张）：信息条只有一行高，
                摆不开一张一人一行的名单，但也不能只剩一句「N 位同事」把人认不出来。
                完整的「谁做到哪一步」在右侧「更多信息」的工作步骤里。
              */}
              <span className="ent-wk-infobar-team" aria-hidden>
                {team.slice(0, 3).map(member => (
                  <EmployeeFace key={member.id} employee={member} name={member.name} size="sm" round />
                ))}
              </span>
              <span>
                <strong>{team.length} 位同事协作</strong>
                <small>{team.map(member => member.name).join('、')}</small>
              </span>
            </>
          )}
        </span>
        <span className="ent-wk-infobar-sep" aria-hidden />
        <span className="ent-wk-infobar-item">
          <small>开始</small>
          <strong>{dayTimeText(work.createdAt)}</strong>
        </span>
        <span className="ent-wk-infobar-item">
          <small>{over ? '耗时' : '已运行'}</small>
          <strong>{over ? durationText(work.updatedAt - work.createdAt) : durationText(Date.now() - work.createdAt)}</strong>
        </span>
        <span className="ent-wk-infobar-item workdir">
          <small>工作目录</small>
          <strong>{work.workDir ? <PathValue path={work.workDir} /> : '默认工作场地'}</strong>
        </span>
        <span className="ent-wk-infobar-progress">
          <span className="ent-bar">
            <span><i className={over ? 'full' : undefined} style={{ width: `${Math.min(100, Math.max(2, percent))}%` }} /></span>
            <b>{percent}%</b>
          </span>
        </span>
      </div>

      <div className="ent-wk-detail">
        {/* 主轴：两种工作类型都以内容为主体，内部滚动 */}
        <div className="ent-wk-detail-main">
          <NeedsYou work={work} workspace={workspace} onTalk={() => setPanel('talk')} />

          {isConversation ? (
            <section className="ent-chat-panel" aria-label="工作对话">
              <WorkConversation work={work} workspace={workspace} />
            </section>
          ) : (
            <div className="ent-wk-grid">
              <section className="ent-panel">
                <h2>{finished ? '工作结果' : '当前进展'}</h2>
                {finished ? (
                  <div className="ent-wk-done">
                    <CheckCircle2 size={30} aria-hidden />
                    <strong>工作已完成</strong>
                    <p>
                      {work.deliverables.length ? `共产出 ${work.deliverables.length} 个结果文件` : '没有产出文件'}
                      {work.steps.length ? `，完成 ${work.steps.length} 个步骤` : ''}
                    </p>
                    <button
                      type="button"
                      className="ent-btn sm"
                      title="打开对话，看员工给出的最后一段说明"
                      onClick={() => setPanel('talk')}
                    >
                      查看总结
                    </button>
                  </div>
                ) : (
                  <div className="ent-donut">
                    <Donut percent={percent} />
                    <p>{doing}</p>
                    {next ? <span className="ent-wk-next">预计下一步：{next.title}</span> : null}
                  </div>
                )}
              </section>
              <Process work={work} />
            </div>
          )}
        </div>

        {/*
          侧栏：产出与过程。
          这段产出结果原先在页面底部、对两种工作类型都渲染，是共用的一段；
          这里把它挪进侧栏，不另写一份 —— 上次重复渲染就是因为新写了一份而没有删掉旧的。
        */}
        <aside className="ent-wk-detail-side">
          <section className="ent-panel">
            <h2>{finished ? '产出结果' : '最终产物'} <em>（{work.deliverables.length} 个）</em></h2>
            {work.deliverables.length ? (
              <ul className="ent-wk-files ent-wk-files-side">
                {work.deliverables.map(file => (
                  <li key={file.id}>
                    <span className={`ent-wk-kind ${kindOf(file.name)}`} aria-hidden>{extOf(file.name)}</span>
                    <span>
                      <strong title={file.name}>{file.name}</strong>
                      <small>{file.note}</small>
                    </span>
                    <button type="button" className="ent-btn sm" title={file.path} onClick={() => void copy(file.path)}>
                      复制路径
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ent-hint">员工还没有产出文件。产出之后会列在这里。</p>
            )}
          </section>

          {/*
            对话式工作没有步骤报表，工作过程就放在侧栏；
            流程工作的过程报表在主栏，这里不再重复一份。
          */}
          {isConversation ? <Process work={work} /> : null}

          {/* 工作信息折叠：低频信息不占首屏。多人协作时「谁做到哪一步」也在里面的工作步骤里。 */}
          <MoreInfo work={work} />
        </aside>
      </div>
      {panel === 'talk' ? <WorkTalkDrawer work={work} workspace={workspace} onClose={() => setPanel(null)} /> : null}
      {panel === 'plan' ? <WorkPlanDrawer work={work} workspace={workspace} onClose={() => setPanel(null)} /> : null}
    </div>
  );
}

/**
 * 「现在需要你」。工作停在原地时，那一句话和唯一一颗能让它继续的按钮。
 *
 * 位置就是原来对话模块的位置 —— 那条提示本来是对话模块的第一块，
 * 对话搬进抽屉之后它留在页面上，页面的排版因此和以前一样。
 *
 * 已终止的工作也在这里给「重新执行」：抬头那颗主按钮改成按工作类型给之后，
 * 它不再是「重新执行」，不放在这里就没地方重开一项已经终止的工作。
 *
 * 流程工作多给一颗「补充说明」：确认是「就这样，继续」，但有时候你要说的是
 * 「这里改一下再继续」，那就得开对话。对话式工作不给 —— 它抬头上那颗主按钮
 * 本来就是「继续对话」。
 */
function NeedsYou({ work, workspace, onTalk }: { work: WorkItem; workspace: EnterpriseWorkspace; onTalk: () => void }) {
  const talkable = work.kind === 'flow';

  if (work.status === 'waiting-user') {
    return (
      <div className="ent-flow-act">
        <AlertTriangle size={16} aria-hidden />
        <p>现在需要你：{work.nextUserAction ?? '看一下结果再决定怎么继续'}</p>
        {talkable ? (
          <button type="button" className="ent-btn sm" onClick={onTalk}>
            <MessageSquareText size={13} aria-hidden />
            补充说明
          </button>
        ) : null}
        <button type="button" className="ent-btn primary sm" onClick={() => void workspace.confirmStep(work.id)} disabled={workspace.busy}>
          <CheckCircle2 size={13} aria-hidden />
          确认，继续
        </button>
      </div>
    );
  }

  if (work.status === 'failed') {
    return (
      <div className="ent-flow-act danger">
        <XCircle size={16} aria-hidden />
        <p>{work.stopReason ? `中断原因：${work.stopReason}` : work.nextUserAction ?? '这项工作中断了，看一下再决定怎么继续'}</p>
        {talkable ? (
          <button type="button" className="ent-btn sm" onClick={onTalk}>
            <MessageSquareText size={13} aria-hidden />
            补充说明
          </button>
        ) : null}
        <button type="button" className="ent-btn primary sm" onClick={() => void workspace.retryWork(work.id)} disabled={workspace.busy}>
          <RotateCcw size={13} aria-hidden />
          重新试一次
        </button>
      </div>
    );
  }

  if (work.status === 'paused') {
    return (
      <div className="ent-flow-act quiet">
        <StopCircle size={16} aria-hidden />
        <p>这项工作已终止{work.stopReason ? `：${work.stopReason}` : ''}。已完成的动作和已产出的文件都还留着。</p>
        <button type="button" className="ent-btn primary sm" onClick={() => void workspace.retryWork(work.id)} disabled={workspace.busy}>
          <RotateCcw size={13} aria-hidden />
          重新执行
        </button>
      </div>
    );
  }

  return null;
}

/**
 * 「更多信息」。默认折叠，展开时高度从 0fr 过渡到 1fr（220ms），箭头同时转 180°。
 * 用受控的按钮 + 网格行高而不是 <details>：<details> 的高度没法过渡，
 * 点开就是一次硬跳。
 */
function MoreInfo({ work }: { work: WorkItem }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`ent-wk-more${open ? ' open' : ''}`}>
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        更多信息
        <ChevronDown size={14} aria-hidden />
      </button>
      <div className="ent-wk-more-fold" aria-hidden={!open}>
        <div>
          <h3>工作目标</h3>
          <p className="ent-prose">{work.goal || '没有单独写目标。'}</p>
          {work.sharedContext.confirmedInputs.length ? (
            <>
              <h3>你已确认可以使用的资料</h3>
              <ul className="ent-list good">
                {work.sharedContext.confirmedInputs.map(item => <li key={item}>{item}</li>)}
              </ul>
            </>
          ) : null}
          {work.steps.length ? (
            <>
              <h3>工作步骤</h3>
              <ol className="ent-work-steps">
                {work.steps.map((step, index) => (
                  <li key={step.id} className={step.state}>
                    <span className="ent-work-step-no">{index + 1}</span>
                    <span>
                      <strong>{step.title}</strong>
                      <small>{step.employeeName}{step.output ? ` · 产出 ${step.output}` : ''}</small>
                    </span>
                    <StepStateChip value={step.state} />
                  </li>
                ))}
              </ol>
            </>
          ) : null}
          {work.stopReason ? (
            <>
              <h3>{work.status === 'paused' ? '终止原因' : '中断原因'}</h3>
              <p className="ent-prose">{work.stopReason}</p>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** 参与这项工作的员工，去重后按「当前负责人在最前」排。 */
function useTeam(work: WorkItem, workspace: EnterpriseWorkspace): SiliconEmployee[] {
  return useMemo(() => {
    const ids = [...new Set([work.currentEmployeeId, ...work.participants, ...work.steps.map(step => step.employeeId)])].filter(Boolean);
    return ids
      .map(id => workspace.employees.find(item => item.id === id))
      .filter((item): item is SiliconEmployee => Boolean(item));
  }, [work, workspace.employees]);
}

/**
 * 进度圆环。百分比写在环心 —— 环只回答「大概到哪了」，精确值靠数字。
 * 进行中的工作打开页面时从 0 平滑走到实际进度（900ms ease-out），只走一次，不循环。
 * 走的是 stroke-dashoffset 而不是 dasharray：后者过渡时两段虚线会一起变，边缘会抖。
 */
function Donut({ percent }: { percent: number }) {
  const size = 66;
  const stroke = 7;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const target = Math.min(100, Math.max(0, percent));
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (reduced) { setShown(target); return; }
    // 先让浏览器画出 0% 的那一帧，否则过渡没有起点，等于直接跳到终值。
    const timer = window.setTimeout(() => setShown(target), 40);
    return () => window.clearTimeout(timer);
  }, [target, reduced]);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`当前进度 ${percent}%`}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#eceef5" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--ent-brand-solid)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - shown / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={reduced ? undefined : { transition: 'stroke-dashoffset 900ms cubic-bezier(.22, 1, .36, 1)' }}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle">{percent}%</text>
    </svg>
  );
}

/** 工作过程。多人协作时上面一排页签按人筛，单人工作不出现页签。 */
/** 用户只看结构化动作；原始日志仍由后台保留，不在详情页呈现。 */
function Process({ work }: { work: WorkItem }) {
  return (
    <section className="ent-panel ent-work-process">
      <h2>工作过程</h2>
      <p className="ent-process-current" role="status">当前：{currentWorkOperation(work.status, work.activities)}</p>
      {work.activities.length ? (
        <ol className="ent-wk-activity-list" aria-label="工作执行记录" tabIndex={0}>
          {work.activities.map(activity => <WorkActivityRow key={`${activity.runId}:${activity.id}`} activity={activity} />)}
        </ol>
      ) : <p className="ent-hint">暂无可展示的执行步骤。</p>}
    </section>
  );
}

function WorkActivityRow({ activity }: { activity: WorkActivity }) {
  const stateLabel = activity.state === 'running'
    ? '进行中'
    : activity.state === 'waiting-user'
      ? '等待确认'
      : activity.state === 'failed'
        ? '失败'
        : '已完成';
  return (
    <li className={`ent-wk-activity ${activity.state}`}>
      <span className="ent-wk-activity-icon" aria-hidden>
        {activity.state === 'running' ? <LoaderCircle size={14} className="ent-spin" /> : activity.state === 'failed' ? <XCircle size={14} /> : activity.state === 'waiting-user' ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
      </span>
      <span className="ent-wk-activity-copy"><strong>{processActivityLabel(activity)}</strong><small>{stateLabel}</small></span>
      <time>{hhmm(activity.endedAt ?? activity.startedAt)}</time>
    </li>
  );
}

function ShareButton({ work }: { work: WorkItem }) {
  const [done, setDone] = useState(false);
  const share = () => {
    const lines = [
      work.title,
      `状态：${work.status === 'completed' ? '已完成' : work.status === 'failed' ? '已中断' : '进行中'} · 进度 ${Math.round(work.progress)}%`,
      `开始：${stampText(work.createdAt)} · 更新：${dayTimeText(work.updatedAt)}`,
      work.goal ? `目标：${work.goal}` : '',
      work.deliverables.length ? `产出：${work.deliverables.map(file => file.name).join('、')}` : '',
    ].filter(Boolean);
    void copy(lines.join('\n')).then(ok => {
      setDone(ok);
      window.setTimeout(() => setDone(false), 2000);
    });
  };
  return (
    <button type="button" className="ent-btn sm" onClick={share} title="把这项工作的摘要复制到剪贴板">
      <Share2 size={14} aria-hidden />
      {done ? '已复制' : '分享'}
    </button>
  );
}

/** 工作目录：一行放不下就省略，右边一个复制按钮。 */
function PathValue({ path }: { path: string }) {
  return (
    <span className="ent-wk-path">
      <span title={path}>{path}</span>
      <button type="button" className="ent-wk-copy" onClick={() => void copy(path)} aria-label="复制工作目录">
        <Copy size={13} aria-hidden />
      </button>
    </span>
  );
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 剪贴板被浏览器策略拦下时静默失败：这只是一个便利动作，不该弹错误。
    return false;
  }
}

function hhmm(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const KIND: Record<string, string> = {
  pdf: 'pdf', xlsx: 'sheet', xls: 'sheet', csv: 'sheet', pptx: 'slide', ppt: 'slide',
  docx: 'doc', doc: 'doc', md: 'doc', txt: 'doc',
};

function extOf(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return (ext || 'file').slice(0, 4).toUpperCase();
}

function kindOf(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return KIND[ext] ?? 'other';
}
