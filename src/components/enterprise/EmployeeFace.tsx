/**
 * 员工头像。设计稿用的是一批 3D 卡通人像图片，仓库里没有那些图，
 * 所以这里用内联 SVG 画一套扁平卡通人像：不依赖网络、不占安装包、任何尺寸都清晰。
 *
 * 同一位员工永远是同一张脸：发型、肤色、衣服、底色全部由 seed（员工 id）哈希决定，
 * 不随渲染次数变化，也不需要后端提供头像字段。等平台能下发真实头像时，
 * 只要把这个组件内部换成 <img>，所有调用点都不用动。
 */

import { useId } from 'react';

type Size = 'sm' | 'md' | 'lg' | 'xl' | 'card';

interface Props {
  /** 决定长相的种子，传员工 id。同一个 id 永远得到同一张脸。 */
  seed: string;
  size?: Size;
  /** 圆形裁切。账号头像和成员列表用圆形，员工卡用圆角方片（设计稿如此）。 */
  round?: boolean;
  className?: string;
}

/** 肤色 / 发色 / 衣服 / 底色四组取值。都是低饱和的柔色，凑在一起不会花。 */
const SKIN = ['#f7d5bb', '#f0c4a2', '#e6b28c'];
const HAIR = ['#2e2933', '#3c2e27', '#4b3a30', '#211d26'];
const WEAR = ['#31344a', '#8e95a8', '#e7b8c3', '#e9ecf5', '#5a79a6', '#b8c5dd'];
const BACK: [string, string][] = [
  ['#eceefc', '#dcdff9'],
  ['#f3e8fc', '#e7dbf9'],
  ['#e7f0fd', '#d8e7fb'],
  ['#fdeff3', '#f9e0e9'],
  ['#e8f6f0', '#d8ecdf'],
  ['#fdf4e6', '#f9e8d2'],
];

/** 字符串 → 稳定的正整数。乘 31 累加，够散且不需要引入依赖。 */
function hash(seed: string): number {
  let value = 0;
  for (let index = 0; index < seed.length; index += 1) {
    value = (value * 31 + seed.charCodeAt(index)) % 0x7fffffff;
  }
  return value;
}

export function EmployeeFace({ seed, size = 'md', round = false, className }: Props) {
  const gradientId = useId();
  const key = hash(seed || 'sep');
  const style = key % 6;
  const skin = SKIN[Math.floor(key / 6) % SKIN.length]!;
  const hair = HAIR[Math.floor(key / 37) % HAIR.length]!;
  const wear = WEAR[Math.floor(key / 211) % WEAR.length]!;
  const back = BACK[Math.floor(key / 1301) % BACK.length]!;
  const glasses = style === 4 || Math.floor(key / 7919) % 5 === 0;

  return (
    <span className={`ent-face ${size}${round ? ' round' : ''}${className ? ` ${className}` : ''}`} aria-hidden>
      {/*
        slice：任何长宽比的容器都铺满，半身像居中裁切，不会被压扁。
        viewBox 只取 8..56 / 4..52 这一块（画布是 64×64）—— 相当于把镜头推近，
        人像占满画片，四周不留一圈空底色。
      */}
      <svg viewBox="8 4 48 48" preserveAspectRatio="xMidYMid slice" focusable="false">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={back[0]} />
            <stop offset="1" stopColor={back[1]} />
          </linearGradient>
        </defs>
        <rect width="64" height="64" fill={`url(#${gradientId})`} />

        {/* 长发和波波头垫在头与肩之前，否则会盖住脸。 */}
        {style === 2 ? <path d="M15 32q0-19 17-19t17 19v16q-4 3-8 2V33q-9 5-18 0v17q-4 1-8-2z" fill={hair} /> : null}
        {style === 3 ? <path d="M17 31q0-17 15-17t15 17v10q-4 2-7 1V32q-8 4-16 0v10q-3 1-7-1z" fill={hair} /> : null}

        {/* 肩膀。整张脸的下半部分靠它收边，衣服颜色也是区分员工的一环。 */}
        <path d="M6 64q4-17 26-17t26 17z" fill={wear} />
        <path d="M32 47q4 5 4 9h-8q0-4 4-9z" fill="#fff" opacity=".22" />

        <rect x="28.6" y="37" width="6.8" height="9" rx="3.2" fill={skin} />
        {/* 后脑的头发比脸大一圈，露出的月牙就是发际线。 */}
        <circle cx="32" cy="27" r="14" fill={hair} />
        <ellipse cx="32" cy="29.2" rx="12.3" ry="12.9" fill={skin} />
        <circle cx="19.9" cy="30" r="2.4" fill={skin} />
        <circle cx="44.1" cy="30" r="2.4" fill={skin} />

        {/* 发型：刘海、丸子头、短刺，都画在脸上方。 */}
        {style === 1 ? <path d="M19 25q2-12 13-12t13 12q-6-5-14-4-6 1-12 4z" fill={hair} /> : null}
        {style === 3 ? <path d="M19.5 24q3-10 12.5-10T44.5 24q-6-4-12.5-4T19.5 24z" fill={hair} /> : null}
        {style === 4 ? <circle cx="32" cy="10.5" r="5" fill={hair} /> : null}
        {style === 5 ? (
          <g fill={hair}>
            <path d="M23 16l3-6 3 6z" />
            <path d="M29.5 14l2.5-7 2.5 7z" />
            <path d="M36 16l3-6 3 6z" />
          </g>
        ) : null}

        {/* 眼睛加一点高光，扁平画法也有神。 */}
        <ellipse cx="27" cy="29.6" rx="1.7" ry="2.1" fill="#2b2b3a" />
        <ellipse cx="37" cy="29.6" rx="1.7" ry="2.1" fill="#2b2b3a" />
        <circle cx="27.6" cy="28.9" r=".55" fill="#fff" opacity=".9" />
        <circle cx="37.6" cy="28.9" r=".55" fill="#fff" opacity=".9" />
        <path d="M29.2 35.4q2.8 2.4 5.6 0" stroke="#c1786a" strokeWidth="1.2" strokeLinecap="round" fill="none" />
        <ellipse cx="23.4" cy="33" rx="2.1" ry="1.3" fill="#f0a3a3" opacity=".38" />
        <ellipse cx="40.6" cy="33" rx="2.1" ry="1.3" fill="#f0a3a3" opacity=".38" />

        {glasses ? (
          <g stroke="#3a3f52" strokeWidth="1.1" fill="none" strokeLinecap="round">
            <circle cx="27" cy="29.6" r="4.5" />
            <circle cx="37" cy="29.6" r="4.5" />
            <path d="M31.5 29.6h1" />
            <path d="M22.5 29h-2.2" />
            <path d="M41.5 29h2.2" />
          </g>
        ) : null}
      </svg>
    </span>
  );
}
