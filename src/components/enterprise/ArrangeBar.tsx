/**
 * 首页底部的派活框。一句话就能派活：在话里点名同事，剩下的照常说。
 *
 * 这里刻意只有一个可选设置 ——「工作场地」，也就是员工产生的文件放在哪。
 * 没有「选择员工」：员工的名字写在话里（例如「小夏，帮我整理…」），
 * 用户想跟谁说就直接叫谁，比先在下拉框里选一遍再打字快一步；
 * 框底会实时回显「交给谁」，所以点名有没有被认出来是看得见的。
 *
 * 它是「说一句话就开工」的入口。要拆步骤、要多人接力，走导航栏的「安排工作」。
 */

import { MapPin, Send, X } from 'lucide-react';
import { useState } from 'react';
import type { SiliconEmployee } from '../../features/enterprise/types';

interface Props {
  /** 可以派活的员工，用于认出话里点的名字。 */
  employees: SiliconEmployee[];
  busy: boolean;
  onSend: (employeeId: string, text: string, workDir: string) => void;
  /** 打开系统的选择文件夹对话框，取消时返回 null。 */
  onChooseSite: () => Promise<string | null>;
}

/**
 * 认出话里点到的同事。名字长的先比：「小明」和「小明明」同时在册时不能认错人。
 * 只有一位员工时不需要点名 —— 那句话只可能是跟他说的。
 */
function whoIn(text: string, employees: SiliconEmployee[]): SiliconEmployee | undefined {
  if (employees.length === 1) return employees[0];
  return [...employees]
    .sort((left, right) => right.name.length - left.name.length)
    .find(employee => text.includes(employee.name));
}

/** 路径只显示最后一段，全路径走 title —— 底栏一行放不下 D:/…/… 这种长路径。 */
function siteLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export function ArrangeBar({ employees, busy, onSend, onChooseSite }: Props) {
  const [text, setText] = useState('');
  const [site, setSite] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const sample = employees[0]?.name ?? '同事';
  const who = whoIn(text.trim(), employees);

  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    if (!who) { setNotice(`在话里点一下同事的名字，例如「${sample}，帮我…」`); return; }
    onSend(who.id, value, site.trim());
    setText('');
    setNotice(null);
  };

  return (
    <div className="ent-arrangebar">
      <section className="ent-arrangebar-card">
        <textarea
          className="ent-arrangebar-input"
          value={text}
          placeholder={`告诉我你想让员工做什么，例如：${sample}，帮我整理一下上周的运营数据`}
          aria-label="要安排的工作"
          onChange={event => { setText(event.target.value); setNotice(null); }}
          onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); } }}
        />

        <div className="ent-arrangebar-foot">
          <button
            type="button"
            className={`ent-arrangebar-site${site ? ' on' : ''}`}
            title={site ? `工作场地：${site}` : '员工产生的文件放在哪。不设就用默认工作场地。'}
            onClick={() => void onChooseSite().then(path => { if (path) setSite(path); })}
          >
            <MapPin size={13} aria-hidden />
            <span>{site ? siteLabel(site) : '设定工作场地'}</span>
          </button>
          {site ? (
            <button type="button" className="ent-arrangebar-clear" onClick={() => setSite('')} aria-label="改回默认工作场地">
              <X size={12} aria-hidden />
            </button>
          ) : null}

          {notice
            ? <span className="ent-arrangebar-note" role="status">{notice}</span>
            : who && text.trim() ? <span className="ent-arrangebar-who">交给 <b>{who.name}</b></span> : null}

          <span className="ent-ask-spacer" />
          <button
            type="button"
            className="ent-ask-send"
            onClick={send}
            disabled={!text.trim() || busy}
            title="发出这项工作（Ctrl + Enter）"
            aria-label="发出这项工作"
          >
            <Send size={15} aria-hidden />
          </button>
        </div>
      </section>
    </div>
  );
}


