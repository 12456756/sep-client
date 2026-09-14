/**
 * 工作记录。一条记录就是一项工作的完整交代：
 * 谁参与、现在什么状态、最后给了什么结果、有没有事情还等着你。
 *
 * 「删除记录」和「终止当前工作」都要二次确认，
 * 并且明确告诉用户终止之后哪些东西还留着 —— 已完成的动作、已产生的文件、
 * 已确认的内容和终止原因都会保留，不会一起消失。
 */

import { Activity, AlertTriangle, CheckCircle2, ChevronDown, ClipboardCheck, Copy, FileCheck2, GitBranch, History, PlayCircle, RotateCcw, Search, StopCircle, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty, WorkStatusChip } from '../../components/enterprise/atoms';
import { EmployeeFace } from '../../components/enterprise/EmployeeFace';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { WorkItem, WorkStatus } from '../../features/enterprise/types';
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
  arranging: { label: '查看安排', icon: GitBranch },
  running: { label: '查看进展', icon: Activity },
  'waiting-user': { label: '去确认', icon: CheckCircle2 },
  completed: { label: '查看完成情况', icon: ClipboardCheck },
  failed: { label: '去重试', icon: RotateCcw },
  paused: { label: '去重新执行', icon: PlayCircle },
};

type Bucket = 'all' | 'active' | 'mine' | 'done' | 'stopped';

/**
 * 「未完成」收的是中断了的和被你终止的两种 —— 它们的共同点是「停了，而且没交付」。
 * 终止过的工作不算「进行中」：它不会自己接着跑，摆在进行中会让人以为还有人在做。
 */
const BUCKETS: { id: Bucket; label: string; match: (work: WorkItem) => boolean }[] = [
  { id: 'all', label: '全部', match: () => true },
  { id: 'active', label: '进行中', match: work => work.status === 'running' || work.status === 'arranging' },
  { id: 'mine', label: '需要我处理', match: work => work.status === 'waiting-user' || Boolean(work.nextUserAction) },
  { id: 'done', label: '已完成', match: work => work.status === 'completed' },
  { id: 'stopped', label: '未完成', match: work => work.status === 'failed' || work.status === 'paused' },
];

interface Props {
  workspace: EnterpriseWorkspace;
}

export function WorkRecordsPage({ workspace }: Props) {
  const [search, setSearch] = useState('');
  const [bucket, setBucket] = useState<Bucket>(workspace.route.name === 'records' ? workspace.route.bucket ?? 'all' : 'all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [panel, setPanel] = useState<'result' | 'process'>('process');
  const [removing, setRemoving] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [stopReason, setStopReason] = useState('');

  useEffect(() => {
    if (workspace.route.name === 'records') setBucket(workspace.route.bucket ?? 'all');
  }, [workspace.route]);

  const keyword = search.trim();
  const matcher = BUCKETS.find(item => item.id === bucket) ?? BUCKETS[0];
  const records = workspace.works
    .filter(work => matcher.match(work))
    .filter(work => !keyword || `${work.title} ${work.goal} ${work.currentEmployeeName}`.includes(keyword))
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const open = (work: WorkItem, next: 'result' | 'process') => {
    setPanel(next);
    setOpenId(current => (current === work.id && panel === next ? null : work.id));
  };

  const stop = (work: WorkItem) => {
    void workspace.stopWork(work.id, stopReason.trim() || '用户在工作记录里终止了这项工作');
    setStopping(null);
    setStopReason('');
  };

  return (
    <div className="ent-page">
      <div className="ent-toolbar">
        <div className="ent-record-filters" role="tablist" aria-label="按状态筛选工作记录">
          {BUCKETS.map(item => {
            const count = workspace.works.filter(work => item.match(work)).length;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={bucket === item.id}
                className={bucket === item.id ? 'active' : undefined}
                onClick={() => setBucket(item.id)}
              >
                {item.label}
                <em>{count}</em>
              </button>
            );
          })}
        </div>
        <span className="ent-ask-spacer" />
        <label className="ent-find">
          <Search size={14} aria-hidden />
          <input
            type="search"
            value={search}
            placeholder="搜索工作标题或员工"
            aria-label="搜索工作记录"
            onChange={event => setSearch(event.target.value)}
          />
        </label>
      </div>

      {!records.length ? (
        <Empty title={keyword ? `没有和「${keyword}」相关的工作` : '这里还没有工作记录'}>
          {keyword ? '换一个关键词，或者切换上面的状态看看。' : '安排一项工作之后，它的进展、结果和过程都会记录在这里。'}
        </Empty>
      ) : null}

      <div className="ent-records">
        {records.map(work => {
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
                <WorkStatusChip value={work.status} />
                <span className="ent-tag">最后更新 {relativeTime(work.updatedAt)}</span>
              </div>

              <p className="ent-record-goal">{work.goal}</p>

              <div className="ent-record-people">
                {people.map(id => {
                  const person = workspace.myEmployees.find(item => item.id === id);
                  return (
                    <span key={id} title={person?.name ?? '已停用的员工'}>
                      <EmployeeFace seed={id} size="sm" round />
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
                    <button type="button" className="ent-btn danger sm" onClick={() => stop(work)}>确认终止</button>
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


