/**
 * 员工技能。核心是权限边界：企业标准永远只读，用户只能在它之上建立「我的版本」。
 *
 * 上一版把 5 步流程条、企业标准全文、一整列「看起来能填其实只读」的字段、
 * 不能修改的内容和四个按钮同时摆出来 —— 用户第一次打开时看到一堆输入框，
 * 点进去发现改不了，真正要按的「创建我的版本」还和另外三个按钮混在一起。
 *
 * 这一版按状态给完全不同的页面，而不是同一个页面加禁用态：
 *   还没有我的版本 → 只说清「能改什么 / 不能改什么 / 下一步按哪」，不渲染字段
 *   可以改         → 只有字段和保存，企业全文收进折叠
 *   已提交 / 已采纳 → 只读回顾，看「我改了什么」
 */

import { ArrowLeft, ArrowRight, CheckCircle2, FilePlus2, GitCompare, Info, Lock, Save, Send, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Empty, SkillStateChip } from '../../components/enterprise/atoms';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { EmployeeSkill, MySkillState, SiliconEmployee, SkillField } from '../../features/enterprise/types';
import { relativeTime } from '../../features/enterprise/vocabulary';

/** 这一版的修改只到本机为止，页面上每个入口都要说清楚，不能让用户以为员工已经照着做了。 */
const LOCAL_ONLY = '已保存在这台电脑上。你的员工按这个版本做事，要等技能下发通道打通后才会生效。';

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
      {/* 页标题和说明都在顶栏（见 ClientAppPage），这里不重复写一遍。 */}
      <div className="ent-banner info">
        <Info size={14} aria-hidden />
        <span>你的修改只对你自己生效，保存在这台电脑上。想让全企业都用你的做法，提交企业审核。</span>
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
                {item.my.state === 'none' ? '查看并调整' : '继续调整'}
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

/**
 * 当前状态对应哪一种页面，以及那一句状态说明。
 * 这是唯一的判断点 —— 按钮、提示、渲染哪个面板都读它，不在别处再判断一次 my.state。
 */
function stage(state: MySkillState): { pane: 'intro' | 'edit' | 'review'; note: string } {
  switch (state) {
    case 'none':
      return { pane: 'intro', note: '现在看到的是企业标准。创建我的版本之后才能修改，企业标准不会被改动。' };
    case 'draft':
      return { pane: 'edit', note: `这是你的个人版本，只对你自己生效。${LOCAL_ONLY}` };
    case 'rejected':
      return { pane: 'edit', note: '企业这次没有采纳。看完审核意见后可以继续修改，改好再提交一次。' };
    case 'submitted':
    case 'reviewing':
      return { pane: 'review', note: '已经提交给企业，审核期间不能继续修改。想接着改就先放弃这次提交，重新建立我的版本。' };
    case 'approved':
      return { pane: 'review', note: '企业已经采纳你的修改。要在此基础上继续调整，重新创建我的版本。' };
  }
}

function SkillDetail({ workspace, skill }: { workspace: EnterpriseWorkspace; skill: EmployeeSkill }) {
  const [saved, setSaved] = useState(false);
  const current = stage(skill.my.state);
  const diff = changedFields(skill);
  const users = usersOf(workspace, skill);

  return (
    <div className="ent-page ent-skill-page">
      <button type="button" className="ent-back-link" onClick={() => workspace.navigate({ name: 'skills' })}>
        <ArrowLeft size={13} aria-hidden />
        全部技能
      </button>

      <header className="ent-skill-head2">
        <h1>{skill.name}</h1>
        <SkillStateChip value={skill.my.state} />
        <span className="ent-skill-head2-meta">
          企业版本 {skill.enterpriseVersion}
          {users.length ? ` · ${usersLabel(users)} 在用` : ' · 暂无你的员工使用'}
          {skill.my.updatedAt ? ` · 我的版本更新于 ${relativeTime(skill.my.updatedAt)}` : ''}
        </span>
      </header>
      <p className="ent-skill-desc">{skill.description}</p>

      {/*
        提示条同一时刻最多一条，按「用户此刻最需要知道哪件事」取第一条：
        审核意见 > 刚保存 > 当前状态说明。上一版四条可以一起堆，等于都不说。
        intro 那一屏不出提示条 —— 下面的 CTA 已经把同一句话说过一遍了。
      */}
      {skill.my.state === 'rejected' && skill.my.reviewNote ? (
        <div className="ent-banner danger">
          <Info size={14} aria-hidden />
          <span><strong>企业审核意见：</strong>{skill.my.reviewNote}</span>
        </div>
      ) : saved && current.pane === 'edit' ? (
        <div className="ent-banner ready">
          <CheckCircle2 size={14} aria-hidden />
          <span>个人版本已保存。{LOCAL_ONLY}还没有提交给企业。</span>
        </div>
      ) : current.pane === 'intro' ? null : (
        <div className="ent-banner info">
          <Info size={14} aria-hidden />
          <span>{current.note}</span>
        </div>
      )}

      {current.pane === 'intro' ? <IntroPane workspace={workspace} skill={skill} /> : null}
      {current.pane === 'edit' ? (
        <EditPane workspace={workspace} skill={skill} diff={diff} saved={saved} onSaved={setSaved} />
      ) : null}
      {current.pane === 'review' ? <ReviewPane workspace={workspace} skill={skill} diff={diff} /> : null}
    </div>
  );
}

/**
 * 还没有我的版本时的页面。一屏说完三件事：能改什么、不能改什么、下一步按哪。
 * 刻意不渲染字段列表 —— 不给用户「看起来能填」的假象。
 */
function IntroPane({ workspace, skill }: { workspace: EnterpriseWorkspace; skill: EmployeeSkill }) {
  return (
    <>
      <div className="ent-skill-cta">
        <p>要按你自己的习惯调整，先创建我的版本。企业标准不会被改动，你的改动也只对你自己生效。</p>
        <button type="button" className="ent-btn primary lg" onClick={() => workspace.createMySkillVersion(skill.id)}>
          <FilePlus2 size={15} aria-hidden />
          创建我的版本
        </button>
      </div>

      <div className="ent-skill-two">
        <section>
          <h3>你可以调整</h3>
          <ul className="ent-list good">
            {skill.fields.map(field => (
              <li key={field.id}>
                <strong>{field.label}</strong>
                {field.hint ? <small>{field.hint}</small> : null}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3>你不能调整</h3>
          <p className="ent-hint">这些内容涉及企业统一要求和使用安全，只有企业管理员能改。需要变更请联系管理员。</p>
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

      <EnterpriseBody skill={skill} />
    </>
  );
}

/** 企业标准全文。用户不会逐字读，所以收进折叠，不占半屏。 */
function EnterpriseBody({ skill }: { skill: EmployeeSkill }) {
  return (
    <details className="ent-advanced">
      <summary>查看企业标准全文（只读）</summary>
      <pre className="ent-skill-body">{skill.enterpriseBody}</pre>
    </details>
  );
}

/** 可以改的时候的页面。只有字段和保存，其余全部收起来。 */
function EditPane({ workspace, skill, diff, saved, onSaved }: {
  workspace: EnterpriseWorkspace;
  skill: EmployeeSkill;
  diff: SkillField[];
  saved: boolean;
  onSaved: (value: boolean) => void;
}) {
  const [compare, setCompare] = useState(false);

  return (
    <>
      <div className="ent-skill-fieldhead">
        <h3>我可以调整的内容</h3>
        <p>{diff.length ? `已经改了 ${diff.length} 项。` : '还没有改动，改完记得保存。'}</p>
        {diff.length ? (
          <button type="button" className="link" onClick={() => setCompare(value => !value)} aria-expanded={compare}>
            <GitCompare size={12} aria-hidden />
            {compare ? '收起差异对比' : '差异对比'}
          </button>
        ) : null}
      </div>

      {compare && diff.length ? <DiffList diff={diff} /> : null}

      <div className="ent-skill-fields">
        {skill.fields.map(field => (
          <FieldRow
            key={field.id}
            field={field}
            onChange={value => { workspace.updateSkillField(skill.id, field.id, value); onSaved(false); }}
          />
        ))}
      </div>

      <div className="ent-skill-foot">
        <button
          type="button"
          className="ent-btn primary"
          disabled={saved}
          onClick={() => { workspace.saveMySkillVersion(skill.id); onSaved(true); }}
        >
          <Save size={14} aria-hidden />
          {saved ? '已保存' : '保存个人版本'}
        </button>
        <button
          type="button"
          className="ent-btn"
          disabled={!diff.length}
          onClick={() => { workspace.submitSkillForReview(skill.id); onSaved(false); }}
          title={diff.length ? undefined : '和企业版本一样，没有需要审核的内容'}
        >
          <Send size={14} aria-hidden />
          提交企业审核
        </button>
        <span className="ent-skill-foot-gap" />
        <button type="button" className="link danger" onClick={() => { workspace.discardMySkillVersion(skill.id); onSaved(false); }}>
          <Undo2 size={13} aria-hidden />
          放弃我的版本
        </button>
      </div>

      <EnterpriseBody skill={skill} />
      <LockedList skill={skill} />
    </>
  );
}

/** 已提交 / 已采纳时的页面。只回顾「我改了什么」，不给可编辑字段。 */
function ReviewPane({ workspace, skill, diff }: { workspace: EnterpriseWorkspace; skill: EmployeeSkill; diff: SkillField[] }) {
  return (
    <>
      <div className="ent-skill-fieldhead">
        <h3>我改了什么</h3>
        <p>
          {diff.length ? `${diff.length} 项与企业版本不同。` : '这一版和企业版本一致。'}
          {skill.my.submittedAt ? ` 提交于 ${relativeTime(skill.my.submittedAt)}。` : ''}
        </p>
      </div>

      {diff.length ? <DiffList diff={diff} /> : <p className="ent-hint">没有差异内容可以对比。</p>}

      <div className="ent-skill-foot">
        <button type="button" className="ent-btn primary" onClick={() => workspace.createMySkillVersion(skill.id)}>
          <FilePlus2 size={14} aria-hidden />
          {skill.my.state === 'approved' ? '在此基础上继续调整' : '放弃这次提交，继续修改'}
        </button>
        <span className="ent-skill-foot-gap" />
        <button type="button" className="link danger" onClick={() => workspace.discardMySkillVersion(skill.id)}>
          <Undo2 size={13} aria-hidden />
          放弃我的版本
        </button>
      </div>

      <EnterpriseBody skill={skill} />
      <LockedList skill={skill} />
    </>
  );
}

function LockedList({ skill }: { skill: EmployeeSkill }) {
  return (
    <details className="ent-advanced">
      <summary>不能修改的内容（{skill.lockedItems.length} 项）</summary>
      <p className="ent-hint">这些内容涉及企业统一要求和使用安全，只有企业管理员能调整。需要变更请联系企业管理员。</p>
      <ul className="ent-skill-locked">
        {skill.lockedItems.map(item => (
          <li key={item}>
            <Lock size={13} aria-hidden />
            {item}
          </li>
        ))}
      </ul>
    </details>
  );
}

function DiffList({ diff }: { diff: SkillField[] }) {
  return (
    <div className="ent-skill-diff">
      {diff.map(field => (
        <div key={field.id}>
          <strong>{field.label}</strong>
          <span className="was">企业版本：{field.enterpriseValue || '（空）'}</span>
          <span className="now">我的修改：{field.myValue || '（空）'}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 单个可调整字段。改动过的行行首出现一条品牌色竖条 ——
 * 替掉原来的「已改动」文字标签，少一个视觉元素，扫一眼就知道改了哪几行。
 */
function FieldRow({ field, onChange }: { field: SkillField; onChange: (value: string) => void }) {
  const changed = field.myValue.trim() !== field.enterpriseValue.trim();
  return (
    <label className={`ent-field ent-skill-field${changed ? ' changed' : ''}`}>
      <span>{field.label}</span>
      {field.kind === 'enum' ? (
        <select className="ent-select" value={field.myValue} onChange={event => onChange(event.target.value)}>
          {(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : field.kind === 'long-text' ? (
        <textarea className="ent-textarea" value={field.myValue} onChange={event => onChange(event.target.value)} />
      ) : (
        <input className="ent-input" value={field.myValue} onChange={event => onChange(event.target.value)} />
      )}
      <small>{field.hint}</small>
      {changed ? <small className="ent-field-was">企业版本：{field.enterpriseValue || '（空）'}</small> : null}
    </label>
  );
}


