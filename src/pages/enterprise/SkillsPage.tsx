/**
 * 员工技能。核心是权限边界：
 * 企业标准永远只读，用户只能在它之上建立「我的版本」，
 * 修改保存在本地，想让全企业生效必须提交企业审核。
 *
 * 界面上必须同时讲清三件事：
 * 1. 哪些可以改（工作偏好、输出格式、语言风格、详细程度、个人规则与示例）；
 * 2. 哪些不能改，以及为什么不能改（企业通用规则、权限范围、工具权限、安全限制、基础职责）；
 * 3. 我的修改和企业版本差在哪里。
 */

import { ArrowLeft, ArrowRight, CheckCircle2, FilePlus2, GitCompare, Info, Lock, Save, Send, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Empty, SkillStateChip } from '../../components/enterprise/atoms';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { EmployeeSkill, SiliconEmployee, SkillField } from '../../features/enterprise/types';
import { relativeTime } from '../../features/enterprise/vocabulary';

/** 提交流程。用户在任何时候都能看到自己走到哪一步。 */
const FLOW = ['查看企业技能', '创建我的版本', '修改内容', '保存个人版本', '提交企业审核'] as const;

interface Props {
  workspace: EnterpriseWorkspace;
  skillId?: string;
}

export function SkillsPage({ workspace, skillId }: Props) {
  const skill = skillId ? workspace.skills.find(item => item.id === skillId) : undefined;

  if (skillId && !skill) {
    return (
      <div className="ent-page">
        <Empty title="找不到这个技能">企业可能已经调整了员工技能配置。返回列表看看其他技能。</Empty>
      </div>
    );
  }

  if (skill) return <SkillDetail key={skill.id} workspace={workspace} skill={skill} />;

  return (
    <div className="ent-page">
      <div className="ent-section-head">
        <div>
          <h2>员工技能</h2>
          <p>技能决定员工怎么做事。企业标准由企业维护，你可以建立自己的版本，调整成更符合你习惯的做法。</p>
        </div>
      </div>

      <div className="ent-banner info">
        <Info size={14} aria-hidden />
        <span>你的修改只对你自己生效。想让全企业都用你的做法，提交企业审核，通过后才会并入企业版本。</span>
      </div>

      {!workspace.skills.length ? (
        <Empty title="还没有可以查看的技能">企业为你的员工配置技能后会显示在这里。</Empty>
      ) : null}

      <div className="ent-skill-grid">
        {workspace.skills.map(item => {
          const diff = changedFields(item).length;
          const users = usersOf(workspace, item);
          return (
            <button key={item.id} type="button" className="ent-skill-card" onClick={() => workspace.navigate({ name: 'skills', skillId: item.id })}>
              <span className="ent-skill-card-top">
                <strong>{item.name}</strong>
                <SkillStateChip value={item.my.state} />
              </span>
              <span className="ent-skill-card-desc">{item.description}</span>
              <dl className="ent-skill-card-meta">
                <div><dt>企业版本</dt><dd>{item.enterpriseVersion}</dd></div>
                <div><dt>使用这个技能</dt><dd>{usersLabel(users)}</dd></div>
                <div><dt>我的修改</dt><dd>{diff ? `${diff} 项与企业版本不同` : '与企业版本一致'}</dd></div>
              </dl>
              <span className="ent-skill-card-cta">
                查看并调整
                <ArrowRight size={13} aria-hidden />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 与企业标准不同的字段，差异对比与列表统计都用它，避免两处各算一遍。 */
function changedFields(skill: EmployeeSkill): SkillField[] {
  return skill.fields.filter(field => field.myValue.trim() !== field.enterpriseValue.trim());
}

/**
 * 用这个技能的员工。技能与员工的对应关系由 useEnterpriseWorkspace 统一算好，这里只读取。
 * 必须读 workspace.employees：只有它带上了算好的 skillIds，myEmployees 上这个字段还是空的。
 */
function usersOf(workspace: EnterpriseWorkspace, skill: EmployeeSkill) {
  return workspace.employees.filter(person => person.assignedToMe && person.skillIds.includes(skill.id));
}

/** 使用者的一句话说明。员工多时只列两位，避免长名字在卡片里被折成两行。 */
function usersLabel(users: SiliconEmployee[]): string {
  if (!users.length) return '暂无你的员工使用';
  if (users.length <= 2) return users.map(person => person.name).join('、');
  return `${users[0].name} 等 ${users.length} 名员工`;
}

/** 当前状态下我能做什么：唯一的判断点，按钮与提示都读它。 */
function stage(skill: EmployeeSkill): { step: number; editable: boolean; note: string } {
  switch (skill.my.state) {
    case 'none':
      return { step: 0, editable: false, note: '现在看到的是企业标准。创建我的版本之后才能修改，企业标准不会被改动。' };
    case 'draft':
      return { step: 2, editable: true, note: '这是你的个人版本，只对你自己生效。改好后先保存，需要全企业采用时再提交审核。' };
    case 'submitted':
    case 'reviewing':
      return { step: 4, editable: false, note: '已经提交给企业，审核期间不能继续修改。想接着改就先放弃这次提交，重新建立我的版本。' };
    case 'approved':
      return { step: 4, editable: false, note: '企业已经采纳你的修改。要在此基础上继续调整，重新创建我的版本。' };
    case 'rejected':
      return { step: 2, editable: true, note: '企业这次没有采纳。看完审核意见后可以继续修改，改好再提交一次。' };
  }
}

function SkillDetail({ workspace, skill }: { workspace: EnterpriseWorkspace; skill: EmployeeSkill }) {
  const [saved, setSaved] = useState(false);
  const [compare, setCompare] = useState(false);
  const current = stage(skill);
  const diff = changedFields(skill);
  const users = usersOf(workspace, skill);

  const save = () => {
    workspace.saveMySkillVersion(skill.id);
    setSaved(true);
  };

  return (
    <div className="ent-page">
      <button type="button" className="ent-back-link" onClick={() => workspace.navigate({ name: 'skills' })}>
        <ArrowLeft size={13} aria-hidden />
        全部技能
      </button>

      <header className="ent-card pad ent-skill-head">
        <div>
          <h1>{skill.name}</h1>
          <p>{skill.description}</p>
          <div className="ent-detail-chips">
            <SkillStateChip value={skill.my.state} />
            <span className="ent-tag">企业版本 {skill.enterpriseVersion}</span>
            {skill.my.updatedAt ? <span className="ent-tag">我的版本更新于 {relativeTime(skill.my.updatedAt)}</span> : null}
            <span className="ent-tag">{users.length ? `${usersLabel(users)} 在用` : '暂无你的员工使用'}</span>
          </div>
        </div>
        <div className="ent-skill-head-actions">
          {skill.my.state === 'none' || skill.my.state === 'approved' ? (
            <button type="button" className="ent-btn primary" onClick={() => workspace.createMySkillVersion(skill.id)}>
              <FilePlus2 size={14} aria-hidden />
              创建我的版本
            </button>
          ) : null}
          {current.editable ? (
            <>
              <button type="button" className="ent-btn" onClick={save}>
                <Save size={14} aria-hidden />
                保存个人版本
              </button>
              <button type="button" className="ent-btn primary" onClick={() => { workspace.submitSkillForReview(skill.id); setSaved(false); }} disabled={!diff.length}>
                <Send size={14} aria-hidden />
                提交企业审核
              </button>
            </>
          ) : null}
          {skill.my.state !== 'none' ? (
            <button type="button" className="ent-btn danger ghost" onClick={() => { workspace.discardMySkillVersion(skill.id); setSaved(false); }}>
              <Undo2 size={14} aria-hidden />
              放弃我的版本
            </button>
          ) : null}
        </div>
      </header>

      <ol className="ent-skill-flow">
        {FLOW.map((label, index) => (
          <li key={label} className={index === current.step ? 'active' : index < current.step ? 'done' : undefined}>
            <span>{index + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      <div className={`ent-banner ${skill.my.state === 'rejected' ? 'attention' : 'info'}`}>
        <Info size={14} aria-hidden />
        <span>{current.note}</span>
      </div>

      {skill.my.state === 'rejected' && skill.my.reviewNote ? (
        <div className="ent-banner danger">
          <Info size={14} aria-hidden />
          <span><strong>企业审核意见：</strong>{skill.my.reviewNote}</span>
        </div>
      ) : null}

      {saved && current.editable ? (
        <div className="ent-banner ready">
          <CheckCircle2 size={14} aria-hidden />
          <span>个人版本已保存，你的员工下次做事就会按这个版本来。还没有提交给企业。</span>
        </div>
      ) : null}
      <div className="ent-skill-columns">
        <section className="ent-card pad">
          <h2>企业标准</h2>
          <p className="ent-hint">由企业维护，只能查看。你的修改不会覆盖它。</p>
          <pre className="ent-skill-body">{skill.enterpriseBody}</pre>
        </section>

        <section className="ent-card pad">
          <div className="ent-section-head" style={{ margin: '0 0 12px' }}>
            <div>
              <h2 style={{ margin: 0 }}>我可以调整的内容</h2>
              <p>{current.editable ? '改完记得保存。' : '当前状态下只能查看。'}</p>
            </div>
            {diff.length ? (
              <button type="button" className="link" onClick={() => setCompare(value => !value)}>
                <GitCompare size={12} aria-hidden />
                {compare ? '收起差异对比' : `差异对比（${diff.length} 项）`}
              </button>
            ) : null}
          </div>

          {compare && diff.length ? (
            <div className="ent-skill-diff">
              {diff.map(field => (
                <div key={field.id}>
                  <strong>{field.label}</strong>
                  <span className="was">企业版本：{field.enterpriseValue || '（空）'}</span>
                  <span className="now">我的修改：{field.myValue || '（空）'}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="ent-skill-fields">
            {skill.fields.map(field => (
              <FieldRow
                key={field.id}
                field={field}
                editable={current.editable}
                onChange={value => { workspace.updateSkillField(skill.id, field.id, value); setSaved(false); }}
              />
            ))}
          </div>
        </section>
      </div>

      <section className="ent-card pad">
        <h2>不能修改的内容</h2>
        <p className="ent-hint">这些内容涉及企业统一要求和使用安全，只有企业管理员能调整。需要变更请联系企业管理员。</p>
        <ul className="ent-skill-locked">
          {skill.lockedItems.map(item => (
            <li key={item}>
              <Lock size={13} aria-hidden />
              {item}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** 单个可调整字段。企业原值一直显示在旁边，用户随时知道自己改了什么。 */
function FieldRow({ field, editable, onChange }: { field: SkillField; editable: boolean; onChange: (value: string) => void }) {
  const changed = field.myValue.trim() !== field.enterpriseValue.trim();
  const value = field.myValue || (editable ? '' : field.enterpriseValue);

  return (
    <label className={`ent-field${changed ? ' changed' : ''}`}>
      <span>
        {field.label}
        {changed ? <em className="ent-changed-flag">已改动</em> : null}
      </span>
      {field.kind === 'enum' ? (
        <select className="ent-select" value={value} disabled={!editable} onChange={event => onChange(event.target.value)}>
          {(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : field.kind === 'long-text' ? (
        <textarea className="ent-textarea" value={value} readOnly={!editable} onChange={event => onChange(event.target.value)} />
      ) : (
        <input className="ent-input" value={value} readOnly={!editable} onChange={event => onChange(event.target.value)} />
      )}
      <small>{field.hint}</small>
      {changed ? <small className="ent-field-was">企业版本：{field.enterpriseValue || '（空）'}</small> : null}
    </label>
  );
}

