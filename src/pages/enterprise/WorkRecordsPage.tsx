/**
 * 工作记录。一条记录就是一项工作的完整交代：
 * 谁参与、现在什么状态、最后给了什么结果、有没有事情还等着你。
 *
 * 「删除记录」和「终止当前工作」都要二次确认，
 * 并且明确告诉用户终止之后哪些东西还留着 —— 已完成的动作、已产生的文件、
 * 已确认的内容和终止原因都会保留，不会一起消失。
 */

import { Activity, AlertTriangle, CheckCircle2, ChevronDown, CircleHelp, ClipboardCheck, Copy, FileCheck2, History, LoaderCircle, MessageSquare, PlayCircle, RotateCcw, Search, StopCircle, Trash2, Workflow } from 'lucide-react';
import { useState } from 'react';
import { Empty, WorkStatusChip } from '../../components/enterprise/atoms';
import { EmployeeFace } from '../../components/enterprise/EmployeeFace';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { WorkItem, WorkStatus } from '../../features/enterprise/types';
import {
  countWorkRecordStatuses,
  countWorkRecordTypes,
  filterWorkRecords,
  countUnresolvedWorkRecordTypes,
  readWorkRecordFilters,
  resetWorkRecordFilters,
  type WorkRecordBucket,
  type WorkRecordTypeFilter,
} from '../../features/enterprise/work-record-filters';
import { clockTime, relativeTime } from '../../features/enterprise/vocabulary';

/**
 * 卡片上那颗主按钮说什么。
 *
 * 六种状态六句话，不是「结束了 / 没结束」两档 —— 分两档的话正在跑的工作也写着
 * 「继续工作」（在跑的东西没有什么可继续的），还没开工的草稿也写着「继续工作」，
 * 而中断了的工作写着「查看对话」，跟它自己的状态标签「需要重试」对不上。
 *
 * 六句话都只做一件事：跳到这项工作。刻意不在列表里直接确认或重试 ——
 * 确认要先看结果，重试要先看中断原因，在一排卡片里点一下就发生太容易点错。
 * 到了工作详情页，「确认，继续」和「重新试一次」就在标题底下那条提示里。
 */
const LEAD: Record<WorkStatus, { label: string; icon: typeof ClipboardCheck }> = {
  arranging: { label: '查看安排', icon: Workflow },
  running: { label: '查看进展', icon: Activity },
  'waiting-user': { label: '去确认', icon: CheckCircle2 },
  completed: { label: '查看完成情况', icon: ClipboardCheck },
  failed: { label: '去重试', icon: RotateCcw },
  paused: { label: '去重新执行', icon: PlayCircle },
};

const BUCKETS: { id: WorkRecordBucket; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '进行中' },
  { id: 'mine', label: '需要我处理' },
  { id: 'done', label: '已完成' },
  { id: 'stopped', label: '未完成' },
];

const TYPES: { id: WorkRecordTypeFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'conversation', label: '会话' },
  { id: 'arrangement', label: '编排' },
];

interface Props {
  workspace: EnterpriseWorkspace;
}

export function WorkRecordsPage({ workspace }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [panel, setPanel] = useState<'result' | 'process'>('process');
  const [removing, setRemoving] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [stopReason, setStopReason] = useState('');

  const filters = readWorkRecordFilters(workspace.route);
  const records = filterWorkRecords(workspace.works, filters);
  const statusCounts = countWorkRecordStatuses(workspace.works, filters);
  const typeCounts = countWorkRecordTypes(workspace.works, filters);
  const unresolvedTypes = countUnresolvedWorkRecordTypes(workspace.works, filters);
  const updateFilters = (next: Partial<typeof filters>) => {
    workspace.replaceRoute({ name: 'records', ...filters, ...next });
  };
  const resetFilters = () => workspace.replaceRoute({ name: 'records', ...resetWorkRecordFilters() });

  const open = (work: WorkItem, next: 'result' | 'process') => {
    setPanel(next);
    setOpenId(current => (current === work.id && panel === next ? null : work.id));
  };

  const stop = (work: WorkItem) => {
    void workspace.stopWork(work.id, stopReason.trim() || '用户在工作记录里终止了这项工作').then(ok => {
      if (ok) {
        setStopping(null);
        setStopReason('');
      }
    });
  };

  return (
    <div className="ent-page">
      <div className="ent-record-toolbar">
        <div className="ent-record-filter-row">
          <span className="ent-record-filter-label">状态</span>
          <div className="ent-record-filters" role="group" aria-label="按状态筛选工作记录">
            {BUCKETS.map(item => (
              <button
                key={item.id}
                type="button"
                aria-pressed={filters.bucket === item.id}
                className={filters.bucket === item.id ? 'active' : undefined}
                onClick={() => updateFilters({ bucket: item.id })}
              >
                {item.label}
                <em>{statusCounts[item.id]}</em>
              </button>
            ))}
          </div>
        </div>
        <div className="ent-record-filter-row">
          <span className="ent-record-filter-label">类型</span>
          <div className="ent-record-filters ent-record-type-filters" role="group" aria-label="按类型筛选工作记录">
            {TYPES.map(item => (
              <button
                key={item.id}
                type="button"
                aria-pressed={filters.workType === item.id}
                className={filters.workType === item.id ? 'active' : undefined}
                onClick={() => updateFilters({ workType: item.id })}
              >
                {item.id === 'conversation' ? <MessageSquare size={14} aria-hidden /> : null}
                {item.id === 'arrangement' ? <Workflow size={14} aria-hidden /> : null}
                {item.label}
                <em>{typeCounts[item.id]}</em>
              </button>
            ))}
          </div>
          <label className="ent-find ent-record-search">
            <Search size={14} aria-hidden />
            <input
              type="search"
              value={filters.search}
              placeholder="搜索工作标题或员工"
              aria-label="搜索工作记录"
              onChange={event => updateFilters({ search: event.target.value })}
            />
          </label>
        </div>
      </div>

      {unresolvedTypes.loading ? (
        <p className="ent-record-type-notice loading" role="status">
          <LoaderCircle size={14} aria-hidden />
          {unresolvedTypes.loading} 条记录的类型正在加载，暂仅显示在全部类型中。
        </p>
      ) : null}

      {unresolvedTypes.unavailable ? (
        <div className="ent-record-type-notice unavailable" role="status">
          <CircleHelp size={14} aria-hidden />
          <span>{unresolvedTypes.unavailable} 条记录的类型暂不可用，暂仅显示在全部类型中。</span>
          <button type="button" className="ent-btn sm ghost" onClick={() => workspace.retryWorkTypes()}>
            <RotateCcw size={13} aria-hidden />
            重新读取类型
          </button>
        </div>
      ) : null}

      {!records.length && !workspace.works.length ? (
        <Empty title="这里还没有工作记录">
          安排一项工作之后，它的进展、结果和过程都会记录在这里。
        </Empty>
      ) : null}

      {!records.length && workspace.works.length ? (
        <Empty title="没有符合条件的工作记录">
          <button type="button" className="ent-btn sm ghost" onClick={resetFilters}>
            <RotateCcw size={13} aria-hidden />
            重置筛选
          </button>
        </Empty>
      ) : null}

      <div className="ent-records">
        {records.map(work => {
          const workType = work.workType;
          const typeLabel = workType.state === 'resolved' ? (workType.kind === 'conversation' ? '会话' : '编排') : workType.state === 'loading' ? '类型加载中' : '类型暂不可用';
          const TypeIcon = workType.state === 'resolved'
            ? workType.kind === 'arrangement' ? Workflow : MessageSquare
            : workType.state === 'loading' ? LoaderCircle : CircleHelp;
          const people = [...new Set([work.currentEmployeeId, ...work.participants])].filter(Boolean);
          const expanded = openId === work.id;
          // 已经停下来的三种：做完了、中断了、被你终止了。终止过的工作不能再终止一次。
          const over = work.status === 'completed' || work.status === 'failed' || work.status === 'paused';
          const lead = LEAD[work.status];
          const LeadIcon = lead.icon;
          const result = work.deliverables.length
            ? work.deliverables.map(item => item.name).join('、')
            : over
              ? '这项工作没有留下可交付的文件'
              : '还没有最终结果';

          return (
            <article key={work.id} className={`ent-record${expanded ? ' open' : ''}`}>
              <div className="ent-record-head">
                <button type="button" className="ent-record-title" onClick={() => workspace.navigate({ name: 'work', workId: work.id })}>
                  {work.title}
                </button>
                <span className={`ent-record-type ${workType.state}`} aria-label={`工作类型：${typeLabel}`}>
                  <TypeIcon size={13} aria-hidden />
                  {typeLabel}
                </span>
                <WorkStatusChip value={work.status} />
                <span className="ent-tag">最后更新 {relativeTime(work.updatedAt)}</span>
              </div>

              <p className="ent-record-goal">{work.goal}</p>

              <div className="ent-record-people">
                {people.map(id => {
                  const person = workspace.myEmployees.find(item => item.id === id);
                  return (
                    <span key={id} title={person?.name ?? '已停用的员工'}>
                      <EmployeeFace employee={person} name={person?.name ?? "已停用的员工"} size="sm" round />
                      {person?.name ?? '已停用的员工'}
                    </span>
                  );
                })}
              </div>

              <dl className="ent-record-meta">
                <div><dt>最终结果</dt><dd>{result}</dd></div>
                <div>
                  <dt>待你处理</dt>
                  <dd className={work.nextUserAction ? 'attention' : undefined}>
                    {work.nextUserAction ?? '暂时没有需要你处理的事情'}
                  </dd>
                </div>
              </dl>

              <div className="ent-record-actions">
                <button type="button" className="ent-btn sm primary" onClick={() => workspace.navigate({ name: 'work', workId: work.id })}>
                  <LeadIcon size={13} aria-hidden />
                  {lead.label}
                </button>
                <button type="button" className="ent-btn sm" onClick={() => open(work, 'result')}>
                  <FileCheck2 size={13} aria-hidden />
                  查看结果
                </button>
                <button type="button" className="ent-btn sm" onClick={() => open(work, 'process')}>
                  <History size={13} aria-hidden />
                  查看过程
                  <ChevronDown size={13} aria-hidden className="ent-record-caret" />
                </button>
                <button type="button" className="ent-btn sm ghost" onClick={() => void workspace.duplicateWork(work.id)} disabled={workspace.busy}>
                  <Copy size={13} aria-hidden />
                  复制为新工作
                </button>
                {!over ? (
                  <button type="button" className="ent-btn sm danger ghost" onClick={() => { setStopping(work.id); setStopReason(''); }} disabled={workspace.busy}>
                    <StopCircle size={13} aria-hidden />
                    终止当前工作
                  </button>
                ) : null}
                <button type="button" className="ent-btn sm danger ghost" onClick={() => setRemoving(work.id)} disabled={workspace.busy}>
                  <Trash2 size={13} aria-hidden />
                  删除记录
                </button>
              </div>

              {stopping === work.id ? (
                <div className="ent-confirm">
                  <p>
                    <AlertTriangle size={14} aria-hidden />
                    终止后 {work.currentEmployeeName} 会立刻停手。
                    <strong>已完成的动作、已产生的文件、你已确认的内容和终止原因都会保留</strong>，之后还能继续这项工作。
                  </p>
                  <label className="ent-field">
                    <span>终止原因（会记录在工作过程里）</span>
                    <input className="ent-input" value={stopReason} placeholder="例如：资料给错了，需要重新准备" onChange={event => setStopReason(event.target.value)} />
                  </label>
                  <div className="ent-confirm-foot">
                    <button type="button" className="ent-btn ghost sm" onClick={() => setStopping(null)}>先不终止</button>
                    <button type="button" className="ent-btn danger sm" disabled={workspace.busy} onClick={() => stop(work)}>{workspace.busy ? '正在终止…' : '确认终止'}</button>
                  </div>
                </div>
              ) : null}

              {removing === work.id ? (
                <div className="ent-confirm">
                  <p>
                    <AlertTriangle size={14} aria-hidden />
                    删除记录后，这项工作的对话、过程和结果说明都会从列表里消失，<strong>无法恢复</strong>。
                    已经产生的文件仍然留在工作文件夹里。
                  </p>
                  <div className="ent-confirm-foot">
                    <button type="button" className="ent-btn ghost sm" onClick={() => setRemoving(null)}>先留着</button>
                    <button
                      type="button"
                      className="ent-btn danger sm"
                      onClick={() => { void workspace.deleteWork(work.id); setRemoving(null); setOpenId(null); }}
                    >
                      确认删除
                    </button>
                  </div>
                </div>
              ) : null}

              {expanded ? (
                <div className="ent-record-detail">
                  {panel === 'result' ? (
                    <>
                      <h3>这项工作给你的结果</h3>
                      {work.deliverables.length ? (
                        <ul className="ent-list good">
                          {work.deliverables.map(item => (
                            <li key={item.id}><strong>{item.name}</strong>{item.note ? ` · ${item.note}` : ''}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="ent-hint">还没有可交付的结果。员工产出文件或结论后会出现在这里。</p>
                      )}
                      {work.stopReason ? (
                        <>
                          <h3>{work.status === 'failed' ? '中断原因' : '终止原因'}</h3>
                          <p className="ent-hint">{work.stopReason}</p>
                        </>
                      ) : null}
                      {work.workDir ? (
                        <>
                          <h3>工作文件夹</h3>
                          <p className="ent-hint" title={work.workDir}>{work.workDir}</p>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <h3>工作过程</h3>
                      {work.timeline.length ? (
                        <ol className="ent-timeline">
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
                      ) : (
                        <p className="ent-hint">还没有记录到动作。</p>
                      )}
                    </>
                  )}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
