import { RotateCcw } from 'lucide-react'
import { useMemo } from 'react'
import type { WorkItem } from '../../features/enterprise/types'
import { useArrangementTranscript } from '../../features/enterprise/use-arrangement-transcript'
import { useSkillLibrary } from '../../features/enterprise/use-skill-library'
import { collectWorkSkills, legacyWorkSkillId, selectSkillUsageEvent, workSkillDetails } from '../../features/enterprise/work-skills'

export function WorkSkills({ work, scopeKey, visible }: { work: WorkItem; scopeKey: string; visible: boolean }) {
  const { events, loading, error, reload } = useArrangementTranscript(work.id, scopeKey, selectSkillUsageEvent, visible)
  const skills = useMemo(() => collectWorkSkills(events), [events])
  const needsLibrary = skills.some(skill => !skill.details && legacyWorkSkillId(skill.path))
  const library = useSkillLibrary(scopeKey, visible && needsLibrary)
  const busy = loading || (needsLibrary && library.skillsLoading)
  return <>
    <div className="ent-wk-skills-toolbar"><span>{loading ? '正在读取技能记录…' : error ? '技能记录未完整加载' : `共 ${skills.length} 项技能记录`}</span>
      <button type="button" className="ent-icon-btn" aria-label="刷新技能记录" title="刷新技能记录" disabled={busy || (needsLibrary && (library.skillsRetrySeconds ?? 0) > 0)} onClick={() => { reload(); if (needsLibrary) void library.refreshSkills(); }}><RotateCcw size={15} aria-hidden /></button>
    </div>
    {error ? <p className="ent-hint" role="alert">技能记录暂时无法完整读取，请重试。</p> : null}
    {needsLibrary && library.skillsError ? <p className="ent-hint" role="alert">{library.skillsError}</p> : null}
    {skills.length ? <ul className="ent-wk-skills-list" aria-label="技能使用记录">
      {skills.map(skill => {
        const details = workSkillDetails(skill, library.skills)
        const loadingDetails = !details && (loading || (needsLibrary && library.skillsLoading && !!legacyWorkSkillId(skill.path)))
        return <li key={skill.path}>
          <strong>{details?.name || (loadingDetails ? '正在读取技能名称…' : '技能信息暂不可用')}</strong>
          <span>{[skill.completed ? `已读取 ${skill.completed} 次` : '', skill.pending ? work.isActive ? `${skill.pending} 次读取中` : `${skill.pending} 次结果未确认` : '', skill.failed ? `${skill.failed} 次读取失败` : ''].filter(Boolean).join(' · ')}</span>
          {skill.nodeIds.length ? <small>{skill.nodeIds.map(id => work.steps.find(step => step.id === id)?.title ?? id).join('、')}</small> : null}
          <p className="ent-wk-skill-description">{details?.description?.trim() || (loadingDetails ? '正在读取技能描述…' : details ? '暂无技能描述' : '未能获取此技能的名称和描述')}</p>
        </li>
      })}
    </ul> : !loading && !error ? <p className="ent-hint">暂无技能使用记录</p> : null}
  </>
}
