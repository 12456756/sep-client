/**
 * 首页员工墙上的一张卡。按设计稿：左边一张半身头像片，右边姓名、职能、状态标签，
 * 下面一行「今日工作 x/y」，卡片最下沿一条进度条。
 *
 * 三条规则：
 * 1. 「谁在干活」只由那颗「工作中」标签表达 —— 设计稿里卡片没有发光、没有呼吸，
 *    全页也没有一处在闪。标签取两个信号的并集（平台报的状态 + 本地真的有工作在跑），
 *    否则状态没跟上的同事会显示成「空闲」。
 * 2. 气泡是员工的一句话（做完了请查阅、等你拍板、中断了），点它直接进那项工作。
 *    它必须挡住卡片本身的点击，否则用户点「请查阅」却弹出一个列表，等于跳错地方。
 * 3. 卡片本体点开是侧边抽屉，列他手上的全部工作 —— 卡片只报数，不铺清单。
 */

import { BellRing, Hourglass, XCircle } from 'lucide-react';
import type { SiliconEmployee } from '../../features/enterprise/types';
import { EMPLOYEE_AVAILABILITY } from '../../features/enterprise/vocabulary';
import { StatusChip } from './atoms';
import { EmployeeFace } from './EmployeeFace';

/** 员工卡上那句提醒：做完了请查阅 / 停在你这里等拍板 / 中断了要你看一下。 */
export interface DeskNotice {
  kind: 'done' | 'call' | 'stop';
  workId: string;
  title: string;
  /** 同类提醒还有几项。0 表示只有这一项。 */
  more: number;
}

/** 三种提醒各自的图标和后半句。语气按后果分档：查阅 → 拍板 → 处理。 */
const SAY: Record<DeskNotice['kind'], { icon: typeof BellRing; text: string }> = {
  done: { icon: BellRing, text: '已完成，请查阅' },
  call: { icon: Hourglass, text: '等你拍板' },
  stop: { icon: XCircle, text: '中断了，请看一下' },
};

interface Props {
  employee: SiliconEmployee;
  /** 今天派给他的工作：做完几项 / 一共几项。 */
  load: { done: number; total: number };
  /** 真的在干活。状态标签按它算，不只看平台报的状态。 */
  working: boolean;
  notice: DeskNotice | null;
  onOpen: (employeeId: string) => void;
  onOpenWork: (workId: string) => void;
}

export function EmployeeDeskCard({ employee, load, working, notice, onOpen, onOpenWork }: Props) {
  const idle = employee.availability === 'unavailable';
  const percent = load.total ? Math.round((load.done / load.total) * 100) : 0;
  const say = notice ? SAY[notice.kind] : null;
  const Icon = say?.icon;
  // 暂时不可用的人不管本地有没有工作在跑，都按「不可用」说 —— 那是更强的约束。
  const state = EMPLOYEE_AVAILABILITY[working && !idle ? 'working' : employee.availability];

  return (
    <article className={`ent-desk${idle ? ' off' : ''}`}>
      {notice && say && Icon ? (
        <button
          type="button"
          className={`ent-desk-bubble ${notice.kind}`}
          onClick={() => onOpenWork(notice.workId)}
          title={`《${notice.title}》${say.text}${notice.more ? `（同类提醒还有 ${notice.more} 项）` : ''}`}
        >
          <Icon size={11} aria-hidden />
          <span className="ent-desk-bubble-what">《{notice.title}》</span>
          <span className="ent-desk-bubble-say">{say.text}</span>
          {notice.more ? <em>+{notice.more}</em> : null}
        </button>
      ) : null}

      {/* 整块可点。按钮自己的 aria-label 会盖掉里面状态标签的读法，所以状态在这里再说一遍。 */}
      <button
        type="button"
        className="ent-desk-open"
        onClick={() => onOpen(employee.id)}
        aria-label={`${employee.name}，${employee.roleName}，${state.label}。查看他手上的工作`}
      >
        <EmployeeFace seed={employee.id} size="card" />
        <span className="ent-desk-id">
          <strong title={employee.name}>{employee.name}</strong>
          <small title={employee.department ? `${employee.roleName} · ${employee.department}` : employee.roleName}>
            {employee.roleName}
          </small>
          <StatusChip {...state} />
        </span>
      </button>

      <div className="ent-desk-load">
        今日工作
        <b>{load.total ? `${load.done} / ${load.total}` : '暂无'}</b>
      </div>
      <span className="ent-desk-track" role="img" aria-label={load.total ? `今日已完成 ${load.done} / ${load.total} 项工作` : '今天还没有派活'}>
        <i style={{ width: `${percent}%` }} />
      </span>
    </article>
  );
}
