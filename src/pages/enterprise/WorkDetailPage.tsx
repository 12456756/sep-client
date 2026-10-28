/** 会话与编排共享对话主视图；结果、过程和工作信息按需查看。 */

import {
  AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, Copy, FileOutput, Info, LoaderCircle, MessageSquareText,
  RotateCcw, StopCircle, Trash2, X, XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Empty, StepStateChip } from '../../components/enterprise/atoms';
import { EmployeeFace } from '../../components/enterprise/EmployeeFace';
import { ArrangementSteps } from '../../components/enterprise/arrange/ArrangementSteps';
import { WorkConversation } from '../../components/enterprise/WorkTalkDrawer';
import { IconHint } from '../../components/enterprise/IconHint';
import { WorkStatusIcon, WorkTypeTag } from '../../components/enterprise/WorkIndicators';
import { MediaArtifactsPanel } from '../../components/workspace/MediaArtifactsPanel';
import { ArrangementMediaPanel } from '../../components/workspace/ArrangementMediaPanel';
import { DocumentPreviewButton } from '../../components/workspace/DocumentPreviewButton';
import { useOperationFeedback } from '../../components/feedback/use-operation-feedback';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { SiliconEmployee, WorkActivity, WorkItem } from '../../features/enterprise/types';
import { currentWorkOperation, processActivityLabel } from '../../features/enterprise/work-process';
import { clockTime, dayTimeText, durationText } from '../../features/enterprise/vocabulary';
import { generalAssistant, GENERAL_ASSISTANT_ID } from '../../features/enterprise/general-assistant';
import '../../styles/work-detail.css';

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
  if (work.workType.state !== 'resolved') {
    const loading = work.workType.state === 'loading';
    return <div className="ent-page ent-wk-type-state" role={loading ? 'status' : 'alert'}>
      <h1>{work.title}</h1>
      <p>{loading ? '正在读取工作类型…' : '暂时无法读取工作类型，请重试。'}</p>
      {!loading ? <button type="button" className="ent-btn sm" onClick={workspace.retryWorkTypes}>重新读取工作类型</button> : null}
    </div>;
  }
  // 仅在权威分类已解析后显示该类型的操作；切换工作重置面板。
  return <Detail key={work.id} work={work} workspace={workspace} />;
}

/** 抬头右边和抽屉之间共用的一个状态：现在拉开的是哪个抽屉。 */
type Panel = 'results' | 'process' | 'info' | null;

function Detail({ work, workspace }: { work: WorkItem; workspace: EnterpriseWorkspace }) {
  const { capture } = useOperationFeedback(work.id);
  const copyPath = async (path: string) => {
    const notice = capture();
    if (!await copy(path)) notice.show('路径复制失败，请联系平台管理员');
  };
  const team = useTeam(work, workspace);
  const isConversation = work.kind === 'conversation';
  const finished = work.status === 'completed';
  /** 这项工作已经不会自己往前走了。耗时、结束时间、能不能终止都按它算。 */
  const over = finished || work.status === 'paused' || work.status === 'failed';
  const percent = Math.round(work.progress);
  const runStartedAt = work.isActive
    ? work.currentRunStartedAt ?? null
    : over ? work.lastRunId ? work.lastRunStartedAt ?? null : work.lastRunStartedAt ?? work.startedAt : null;
  const runEndedAt = work.lastRunEndedAt ?? work.completedAt;
  const mediaPhase = work.kind === 'flow' ? work.arrangementExecution?.media?.find(item => !['ready', 'blocked'].includes(item.phase))?.phase ?? null : null;
  const mediaPhaseLabel = mediaPhase === 'preparing' ? '正在准备媒体请求' : mediaPhase === 'awaiting-approval' ? '等待确认媒体请求' : mediaPhase === 'submitted' ? '媒体已提交，等待供应商' : mediaPhase === 'tracking' ? '供应商正在生成媒体' : mediaPhase === 'saving' ? '正在下载并保存媒体' : mediaPhase === 'materializing' ? '正在整理媒体交付结果' : null;
  const [panel, setPanel] = useState<Panel>(null);
  const conversation = useRef<HTMLElement | null>(null);
  const focusConversation = () => conversation.current?.querySelector<HTMLTextAreaElement>('textarea.ent-ask-input')?.focus();
  const inspector = useRef<HTMLDialogElement | null>(null);
  const [mediaSummary, setMediaSummary] = useState<{ images: number | null; videos: number | null; error: string | null }>({ images: null, videos: null, error: null });
  const handleMediaSummary = useCallback((summary: typeof mediaSummary) => setMediaSummary(summary), []);
  const arrangementMedia = work.arrangementExecution?.media;
  const countArrangement = (kind: 'image' | 'video') => arrangementMedia ? new Set(arrangementMedia.filter(item => item.kind === kind).flatMap(item => item.outputs.filter(output => output.status === 'saved').map(output => output.artifactId))).size : null;
  const images = isConversation ? mediaSummary.images : countArrangement('image');
  const videos = isConversation ? mediaSummary.videos : countArrangement('video');
  const resultCounts = [
    `${work.deliverables.length} 个文件`,
    images !== null ? `${images} 张图片` : null,
    videos !== null ? `${videos} 个视频` : null,
  ].filter((item): item is string => Boolean(item));
  const resultsTitle = resultCounts.length ? `产出结果：${resultCounts.join('、')}` : '产出结果';
  const inspectorCloseButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const dialog = inspector.current;
    if (!dialog) return;
    if (panel) {
      if (!dialog.open) dialog.showModal();
      inspectorCloseButton.current?.focus();
    } else if (dialog.open) dialog.close();
  }, [panel]);
  useEffect(() => {
    const dialog = inspector.current;
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  const openInspector = (next: Exclude<Panel, null>) => setPanel(current => current === next ? null : next);
  const facts = {
    start: (
      <span className="ent-wk-infobar-item">
        <small>{runStartedAt === null ? '创建' : '开始'}</small>
        <strong>{dayTimeText(runStartedAt ?? work.createdAt)}</strong>
      </span>
    ),
    elapsed: (
      <span className="ent-wk-infobar-item">
        <small>{work.executionHealth === 'start-failed' ? '启动失败' : runStartedAt === null ? '排队等待' : over ? '本轮耗时' : '本轮已运行'}</small>
        <strong>{runStartedAt === null
          ? work.executionHealth === 'start-failed' ? '未启动' : work.isActive && work.queuedAt ? durationText(Date.now() - work.queuedAt) : work.status === 'arranging' ? '尚未开始' : '未知'
          : over ? runEndedAt === null ? '未知' : durationText(runEndedAt - runStartedAt)
            : durationText(Date.now() - runStartedAt)}</strong>
      </span>
    ),
    directory: (
      <span className="ent-wk-infobar-item workdir">
        <small>工作目录</small>
        <strong>{work.workDir ? <PathValue path={work.workDir} /> : '默认工作场地'}</strong>
      </span>
    ),
    progress: (
      <span className="ent-wk-infobar-progress">
        <span className={`ent-bar${finished ? ' complete' : ''}${mediaPhaseLabel ? ' media-waiting' : ''}`}>
          <span><i className={over ? 'full' : undefined} style={{ width: mediaPhaseLabel ? '38%' : `${Math.min(100, Math.max(2, percent))}%` }} /></span>
          <b>{mediaPhaseLabel ?? `${percent}%`}</b>
        </span>
      </span>
    ),
  };

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
        <WorkStatusIcon work={work} />
        <WorkTypeTag workType={work.workType} />
        <h1>{work.title}</h1>
        <div className="ent-wk-head-actions">
          <IconHint label={resultsTitle} side="bottom"><button type="button" className="ent-icon-btn ent-wk-inspector-trigger" aria-label="查看产出结果" aria-haspopup="dialog" aria-controls={`work-inspector-${work.id}`} aria-expanded={panel === 'results'} onClick={() => openInspector('results')}><FileOutput size={16} aria-hidden /></button></IconHint>
          <IconHint label="工作过程" side="bottom"><button type="button" className="ent-icon-btn ent-wk-inspector-trigger" aria-label="查看工作过程" aria-haspopup="dialog" aria-controls={`work-inspector-${work.id}`} aria-expanded={panel === 'process'} onClick={() => openInspector('process')}><LoaderCircle size={16} aria-hidden /></button></IconHint>
          <IconHint label="工作信息" side="bottom"><button type="button" className="ent-icon-btn ent-wk-inspector-trigger" aria-label="查看工作信息" aria-haspopup="dialog" aria-controls={`work-inspector-${work.id}`} aria-expanded={panel === 'info'} onClick={() => openInspector('info')}><Info size={16} aria-hidden /></button></IconHint>
        </div>
      </div>

      {/* 编排名单独立滚动；对话任务继续使用紧凑的单人信息。 */}
      <div className={`ent-wk-infobar${isConversation ? '' : ' ent-wk-infobar-flow'}`}>
        {isConversation || !team.length ? (
          <span className="ent-wk-infobar-who">
            <EmployeeFace employee={team[0]} name={work.currentEmployeeName} size="sm" round />
            <span>
              <strong>{team[0]?.name ?? work.currentEmployeeName}</strong>
              <small>{team[0]?.roleName ?? '硅基员工'}</small>
            </span>
          </span>
        ) : (
          <section className="ent-wk-team" aria-label="协作员工">
            <strong>{team.length} 位同事协作</strong>
            <ul className="ent-wk-team-list" aria-label="参与员工" tabIndex={0}>
              {team.map(member => (
                <li key={member.id}>
                  <EmployeeFace employee={member} name={member.name} size="sm" round />
                  <span className="ent-wk-team-name">{member.name}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <span className="ent-wk-infobar-sep" aria-hidden />
        {isConversation ? <>{facts.start}{facts.elapsed}{facts.directory}{facts.progress}</> : (
          <div className="ent-wk-infobar-meta">
            <div className="ent-wk-infobar-summary">{facts.start}{facts.elapsed}{facts.progress}</div>
            {facts.directory}
          </div>
        )}
      </div>

      <div className="ent-wk-detail">
        {/* 主轴：两种工作类型都以内容为主体，内部滚动 */}
        <div className="ent-wk-detail-main">
          <NeedsYou work={work} workspace={workspace} onTalk={focusConversation} />
          {work.kind === 'flow' ? <FailedNodeActions work={work} busy={workspace.busy} onRetry={workspace.retryWork} /> : null}

          <section ref={conversation} className="ent-chat-panel" aria-label="工作对话">
            <WorkConversation work={work} workspace={workspace} />
          </section>
        </div>

        {/* 原生模态面板悬浮在工作空间上方，查询组件在关闭时仍保持挂载。 */}
        <dialog
          ref={inspector}
          id={`work-inspector-${work.id}`}
          className="ent-wk-inspector"
          aria-modal="true"
          aria-label="工作详情面板"
          aria-labelledby={`work-inspector-title-${work.id}`}
          onCancel={event => {
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            setPanel(null);
          }}
          onClose={event => { if (event.target === event.currentTarget) setPanel(null); }}
          onClick={event => {
            if (event.target !== event.currentTarget) return;
            const rect = event.currentTarget.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setPanel(null);
          }}
        >
          <div className="ent-wk-inspector-heading"><strong id={`work-inspector-title-${work.id}`}>{panel === 'results' ? '产出结果' : panel === 'process' ? '工作过程' : '工作信息'}</strong><button ref={inspectorCloseButton} type="button" className="ent-icon-btn" aria-label="关闭详情面板" onClick={() => setPanel(null)}><X size={16} aria-hidden /></button></div>
          <section className="ent-panel ent-wk-inspector-content" aria-label="产出结果" hidden={panel !== 'results'}>
            <p className="ent-hint">{resultCounts.join('、')}</p>
            {isConversation ? <MediaArtifactsPanel taskId={work.id} visible={panel === 'results'} onSummary={handleMediaSummary} /> : null}
            {!isConversation && panel === 'results' && work.arrangementExecution?.media?.length ? <ArrangementMediaPanel taskId={work.id} media={work.arrangementExecution.media} /> : null}
            {work.deliverables.length ? (
              <div className="ent-wk-final-files">
                {groupDeliverables(work.deliverables).map(group => (
                  <section key={group.key} className="ent-wk-final-group">
                    {group.title ? <h3>{group.title}</h3> : null}
                    <ul className="ent-wk-files ent-wk-files-side">
                      {group.files.map(file => (
                        <li key={file.id}>
                          <span className={`ent-wk-kind ${kindOf(file.name)}`} aria-hidden>{extOf(file.name)}</span>
                          <span>
                            <strong title={file.name}>{file.name}</strong>
                            <small>{file.note}</small>
                          </span>
                          <div className="ent-wk-file-actions">
                            {file.format ? isConversation
                              ? <DocumentPreviewButton taskId={work.id} fileId={file.id} name={file.name} format={file.format} />
                              : file.nodeId && file.deliverableId ? <DocumentPreviewButton taskId={work.id} nodeId={file.nodeId} deliverableId={file.deliverableId} name={file.name} format={file.format} version={file.previewVersion} /> : null : null}
                            <button type="button" className="ent-btn sm" title={file.path} onClick={() => void copyPath(file.path)}>
                              复制路径
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : (
              <p className="ent-hint">员工还没有产出文件。产出之后会列在这里。</p>
            )}
          </section>

          {/* 工作步骤与活动统一放在过程面板。 */}
          <section className="ent-panel ent-wk-inspector-content" aria-label="工作过程" hidden={panel !== 'process'}>
            <Process work={work} workspace={workspace} />
          </section>

          {/* 工作信息折叠：低频信息不占首屏。多人协作时「谁做到哪一步」也在里面的工作步骤里。 */}
          <section className="ent-panel ent-wk-inspector-content" aria-label="工作信息" hidden={panel !== 'info'}>
            <div className="ent-wk-info-facts"><span>{team.length ? `${team.length} 位协作员工` : work.currentEmployeeName}</span><span>创建于 {dayTimeText(work.createdAt)}</span><span>{runStartedAt === null ? '尚未开始' : `开始于 ${dayTimeText(runStartedAt)}`}</span><span>{over && runEndedAt !== null ? `结束于 ${dayTimeText(runEndedAt)}` : '仍在执行'}</span><span>{work.workDir || '默认工作目录'}</span></div>
            <MoreInfo work={work} />
            <button type="button" className="ent-btn danger ghost sm" disabled={workspace.busy} onClick={() => { void workspace.deleteWork(work.id); }}><Trash2 size={13} aria-hidden />删除记录</button>

          </section>
        </dialog>
      </div>
    </div>
  );
}

/** 等待确认、失败与终止后的恢复操作始终留在主对话区。 */
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
        {!(work.kind === 'flow' && work.arrangementExecution?.nodes.some(node => node.status === 'failed')) ? <button type="button" className="ent-btn primary sm" onClick={() => void workspace.retryWork(work.id)} disabled={workspace.busy}>
          <RotateCcw size={13} aria-hidden />
          重新试一次
        </button> : null}
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
      .map(id => id === GENERAL_ASSISTANT_ID ? generalAssistant([]) : workspace.employees.find(item => item.id === id))
      .filter((item): item is SiliconEmployee => Boolean(item));
  }, [work, workspace.employees]);
}

/**
 * 进度圆环。百分比写在环心 —— 环只回答「大概到哪了」，精确值靠数字。
 * 进行中的工作打开页面时从 0 平滑走到实际进度（900ms ease-out），只走一次，不循环。
 * 走的是 stroke-dashoffset 而不是 dasharray：后者过渡时两段虚线会一起变，边缘会抖。
 */
/** 工作过程。多人协作时上面一排页签按人筛，单人工作不出现页签。 */
/** 用户只看结构化动作；原始日志仍由后台保留，不在详情页呈现。 */
function Process({ work, workspace, showRetry = true }: { work: WorkItem; workspace: EnterpriseWorkspace; showRetry?: boolean }) {
  if (work.kind === 'flow') return <ArrangementProcess work={work} workspace={workspace} showRetry={showRetry} />;
  return (
    <section className="ent-work-process">
      <p className="ent-process-current" role="status">当前：{currentWorkOperation(work.status, work.activities, work.isActive, work.queuedAt)}</p>
      {work.activities.length ? (
        <ol className="ent-wk-activity-list" aria-label="工作执行记录" tabIndex={0}>
          {work.activities.map(activity => <WorkActivityRow key={`${activity.runId}:${activity.id}`} activity={activity} />)}
        </ol>
      ) : work.timeline.length ? (
        /*
          结构化动作只活在运行中的会话里，结束（或重启应用）之后就没了；
          但「做完了也该看得到过程」—— 这时回落到持久化的时间线：
          它由后台日志与产出记录建成，和工作记录页展开的那份是同一个数据。
        */
        <ol className="ent-timeline" aria-label="工作执行记录">
          {work.timeline.map(entry => (
            <li key={entry.id} className={entry.kind}>
              <span className="ent-timeline-dot" aria-hidden />
              <span className="ent-timeline-body">
                <strong>{entry.actor}</strong>
                <span>{entry.text}</span>
                <small>{clockTime(entry.at)}</small>
              </span>
            </li>
          ))}
        </ol>
      ) : <p className="ent-hint">暂无可展示的执行步骤。</p>}
    </section>
  );
}

function ArrangementProcess({ work, workspace, showRetry = true }: { work: WorkItem; workspace: EnterpriseWorkspace; showRetry?: boolean }) {
  const mediaPhase = work.arrangementExecution?.media?.find(item => !['ready', 'blocked'].includes(item.phase))?.phase ?? null;
  const mediaLabel = mediaPhase === 'preparing' ? '正在准备媒体请求'
    : mediaPhase === 'awaiting-approval' ? '等待确认媒体请求'
      : mediaPhase === 'submitted' ? '媒体已提交，等待供应商'
        : mediaPhase === 'tracking' ? '供应商正在生成媒体'
          : mediaPhase === 'saving' ? '正在下载并保存媒体'
            : mediaPhase === 'materializing' ? '正在整理媒体交付结果' : null;
  return (
    <section className="ent-work-process">
      <p className="ent-process-current" role="status">当前：{mediaLabel ?? currentWorkOperation(work.status, work.activities, work.isActive, work.queuedAt)}</p>
      {work.steps.length ? (
        <ArrangementSteps work={work} busy={workspace.busy} onRetry={workspace.retryWork} showRetry={showRetry} />
      ) : <p className="ent-hint">暂无可展示的执行步骤。</p>}
    </section>
  );
}

function FailedNodeActions({ work, busy, onRetry }: { work: WorkItem; busy: boolean; onRetry: (workId: string, nodeId: string) => Promise<void> }) {
  const failed = work.arrangementExecution?.nodes.filter(node => node.status === 'failed') ?? [];
  if (!failed.length) return null;
  const titles = new Map(work.steps.map(step => [step.id, step.title]));
  return (
    <section className="ent-flow-act danger ent-failed-node-actions" aria-label="失败节点操作">
      <XCircle size={16} aria-hidden />
      <div className="ent-failed-node-copy"><strong>有节点执行失败</strong><span>可单独重试失败节点，已完成的结果会保留。</span></div>
      <div className="ent-failed-node-list">
        {failed.map(node => <button key={node.nodeId} type="button" className="ent-btn sm ghost" aria-label={`重试此节点：${titles.get(node.nodeId) ?? node.nodeId}`} disabled={busy} onClick={() => void onRetry(work.id, node.nodeId)}><RotateCcw size={13} aria-hidden />重试 {titles.get(node.nodeId) ?? node.nodeId}</button>)}
      </div>
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

function groupDeliverables(files: WorkItem['deliverables']): Array<{ key: string; title: string; files: WorkItem['deliverables'] }> {
  const groups: Array<{ key: string; title: string; files: WorkItem['deliverables'] }> = [];
  for (const file of files) {
    const key = file.nodeId ?? 'all';
    let group = groups.find(item => item.key === key);
    if (!group) {
      group = { key, title: file.nodeTitle ?? '', files: [] };
      groups.push(group);
    }
    group.files.push(file);
  }
  return groups;
}

/** 只缩短目录的展示文本；悬停和复制始终使用完整路径。 */
function PathValue({ path }: { path: string }) {
  const { capture } = useOperationFeedback(path);
  const copyPath = async () => {
    const notice = capture();
    if (!await copy(path)) notice.show('路径复制失败，请联系平台管理员');
  };
  const separator = path.includes('\\') ? '\\' : '/';
  const parts = path.split(/[\\/]/).filter(Boolean);
  const label = parts.length > 2 ? `…${separator}${parts.slice(-2).join(separator)}` : path;
  return (
    <span className="ent-wk-path">
      <span title={path}>{label}</span>
      <button type="button" className="ent-wk-copy" onClick={() => void copyPath()} aria-label="复制工作目录" title="复制完整工作目录">
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
