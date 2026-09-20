/**
 * 首页员工墙上的一张卡。按设计稿：左边一张半身像，右边姓名、状态，
 * 下面一行「今日工作 x/y」，卡片最下沿一条进度条。
 *
 * 两条规则：
 * 1. 「工作中」只看有没有一项正在跑的工作 —— 卡片不发光、不呼吸，全页没有一处在闪。
 *    标签取两个信号的并集（平台报的状态 + 本地真的有工作在跑），
 *    否则状态没跟上的同事会显示成「空闲」。
 * 2. 「做完了等你查阅 / 等你拍板 / 中断了」都只在状态旁边点一颗小图标，不写字，
 *    也不再有浮在卡片上沿的气泡 —— 那几句话撑出来的浅底色块（尤其是黄和红）
 *    在设计稿的配色里没有，而且会把第一排卡片顶得高低不齐。
 *    要知道是哪一项，点开卡片看抽屉里的清单。
 */

import { BellRing, Hourglass, XCircle } from 'lucide-react';
import type { SiliconEmployee } from '../../features/enterprise/types';
import { EMPLOYEE_AVAILABILITY } from '../../features/enterprise/vocabulary';
import { StatusChip } from './atoms';
import { EmployeeFace } from './EmployeeFace';

/** 状态旁边那几颗小图标：他手上有事要你看一眼。按「先说结果，再说卡住」排。 */
export type DeskFlag = 'done' | 'call' | 'stop';

/** 每颗图标的形状和一句话解释。解释走 title 和 aria-label，卡面上不写字。 */
const FLAG: Record<DeskFlag, { icon: typeof BellRing; hint: string }> = {
  done: { icon: BellRing, hint: '有工作做完了，等你查阅' },
  call: { icon: Hourglass, hint: '有工作停在他这里等你拍板' },
  stop: { icon: XCircle, hint: '有工作中断了，要你看一下' },
};

interface Props {
  employee: SiliconEmployee;
  /** 今天派给他的工作：做完几项 / 一共几项。 */
  load: { done: number; total: number };
  /** 真的在干活。状态标签按它算，不只看平台报的状态。 */
  working: boolean;
  flags: DeskFlag[];
  onOpen: (employeeId: string) => void;
}

export function EmployeeDeskCard({ employee, load, working, flags, onOpen }: Props) {
  const idle = employee.availability === 'unavailable';
  const percent = load.total ? Math.round((load.done / load.total) * 100) : 0;
  // 暂时不可用的人不管本地有没有工作在跑，都按「不可用」说 —— 那是更强的约束。
  const state = EMPLOYEE_AVAILABILITY[working && !idle ? 'working' : employee.availability];
  const said = flags.map(flag => FLAG[flag].hint).join('；');

  return (
    <article className={`ent-desk${idle ? ' off' : ''}`}>
      {/* 整块可点。按钮自己的 aria-label 会盖掉里面状态标签和图标的读法，所以在这里再说一遍。 */}
      <button
        type="button"
        className="ent-desk-open"
        onClick={() => onOpen(employee.id)}
        aria-label={`${employee.name}，${state.label}。${said ? `${said}。` : ''}查看他手上的工作`}
      >
        <EmployeeFace seed={employee.id} size="card" />
        <span className="ent-desk-id">
          <strong title={employee.name}>{employee.name}</strong>
          <span className="ent-desk-state">
            <StatusChip {...state} />
            {flags.map(flag => {
              const Icon = FLAG[flag].icon;
              return <i key={flag} className={`ent-desk-flag ${flag}`} title={FLAG[flag].hint}><Icon size={13} aria-hidden /></i>;
            })}
          </span>
        </span>
      </button>

      <div className="ent-desk-load">
        今日工作
        <b>{load.total ? `${load.done} / ${load.total}` : '暂无'}</b>
      </div>
      <span className="ent-desk-track" role="img" aria-label={load.total ? `今日已完成 ${load.done} / ${load.total} 项工作` : '今天还没有派活'}>
        {/* full：今天的活全做完了，斜纹就停下 —— 到头了还在流动等于说还在推进。 */}
        <i className={percent >= 100 ? 'full' : undefined} style={{ width: `${percent}%` }} />
      </span>
    </article>
  );
}
