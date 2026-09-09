/**
 * 工作目标输入。整页只有这一个输入区，所以它足够大：
 * 一片写字的地方 + 一条工具栏，工具栏上只有两个可选项和一个开始按钮。
 *
 * 「附件」和「知识库」不是新概念，它们各自接到已有的东西上：
 * - 附件   → 选一个文件夹，记成「你已经准备好的资料」，参与这项工作的同事都能看到；
 * - 知识库 → 挑几个员工技能包，整个工作共享。
 * 两者都只是可选的补充，留空也能开始。
 */

import { ArrowRight, BookOpen, Check, Paperclip, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { EmployeeSkill } from '../../../features/enterprise/types';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** 已经准备好的资料，一行一项。 */
  materials: string[];
  onMaterials: (list: string[]) => void;
  skills: EmployeeSkill[];
  skillIds: string[];
  onSkillIds: (ids: string[]) => void;
  onChooseFolder: () => Promise<string | null>;
  submitLabel: string;
  submitDisabled: boolean;
  onSubmit: () => void;
}

export function GoalComposer({
  value, onChange, placeholder, materials, onMaterials,
  skills, skillIds, onSkillIds, onChooseFolder,
  submitLabel, submitDisabled, onSubmit,
}: Props) {
  const [kbOpen, setKbOpen] = useState(false);
  const kb = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!kbOpen) return;
    const close = (event: MouseEvent) => {
      if (!kb.current?.contains(event.target as Node)) setKbOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setKbOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [kbOpen]);

  const attach = () => {
    void onChooseFolder().then(path => {
      if (path && !materials.includes(path)) onMaterials([...materials, path]);
    });
  };

  const toggleSkill = (id: string) => {
    onSkillIds(skillIds.includes(id) ? skillIds.filter(item => item !== id) : [...skillIds, id]);
  };

  return (
    <div className="ent-goal">
      <textarea
        className="ent-goal-input"
        value={value}
        placeholder={placeholder}
        aria-label="工作目标"
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !submitDisabled) onSubmit();
        }}
      />

      {materials.length ? (
        <ul className="ent-goal-files">
          {materials.map(item => (
            <li key={item}>
              <span title={item}>{item}</span>
              <button type="button" onClick={() => onMaterials(materials.filter(one => one !== item))} aria-label={`移除资料 ${item}`}>
                <X size={11} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="ent-goal-bar">
        <button type="button" className="ent-goal-tool" onClick={attach} title="选一个装着资料的文件夹，参与这项工作的同事都能看到">
          <Paperclip size={14} aria-hidden />
          附件
        </button>

        <div className="ent-goal-kb" ref={kb}>
          <button
            type="button"
            className={`ent-goal-tool${skillIds.length ? ' on' : ''}`}
            onClick={() => setKbOpen(open => !open)}
            aria-expanded={kbOpen}
            aria-haspopup="menu"
            disabled={!skills.length}
            title={skills.length ? undefined : '企业还没有可共享的技能包'}
          >
            <BookOpen size={14} aria-hidden />
            知识库
            {skillIds.length ? <em>{skillIds.length}</em> : null}
          </button>
          {kbOpen ? (
            <div className="ent-goal-pop" role="menu">
              <p>整个工作共享的技能包。选择记在这台电脑上，下发通道打通后才会真的给到员工。</p>
              {skills.map(skill => {
                const on = skillIds.includes(skill.id);
                return (
                  <button key={skill.id} type="button" role="menuitemcheckbox" aria-checked={on} onClick={() => toggleSkill(skill.id)}>
                    <span className={`ent-goal-tick${on ? ' on' : ''}`} aria-hidden>{on ? <Check size={11} /> : null}</span>
                    <span>
                      <strong>{skill.name}</strong>
                      <small>{skill.description}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <span className="ent-goal-gap" />

        <button type="button" className="ent-arr-primary" onClick={onSubmit} disabled={submitDisabled}>
          {submitLabel}
          <ArrowRight size={15} aria-hidden />
        </button>
      </div>
    </div>
  );
}
