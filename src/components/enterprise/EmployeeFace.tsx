/**
 * 员工头像。用 DiceBear 的 toon-head 画片：一批带柔和明暗的立体感半身像，
 * 和设计稿那种 3D 卡通人像是同一路子。SVG 在本地生成，不联网、不占安装包、任何尺寸都清晰。
 *
 * 同一位员工永远是同一张脸：seed（员工 id）决定发型、肤色、衣服、底色，
 * 不随渲染次数变化，也不需要后端提供头像字段。等平台能下发真实头像时，
 * 只要把这个组件内部换成 <img>，所有调用点都不用动。
 *
 * 表情和配色刻意收窄（见 LOOK）：生气、张嘴、夸张笑脸这些在企业员工卡上不合适，
 * 衣服和底色也只留低饱和的几档 —— 一整墙卡片摆在一起才不会花。
 *
 * 画片版权：ToonHead by Johan Melin，CC BY 4.0，见 THIRD-PARTY-NOTICES.md。
 * 署名信息由 DiceBear 写进每张 SVG 的 <metadata> 里，随界面一起分发。
 */

import * as React from 'react';
import { createAvatar, type StyleOptions } from '@dicebear/core';
import * as toonHead from '@dicebear/toon-head';
import type { Options as ToonHeadOptions } from '@dicebear/toon-head';

type Size = 'sm' | 'md' | 'lg' | 'xl' | 'card';

interface Props {
  /** 决定长相的种子，传员工 id。同一个 id 永远得到同一张脸。 */
  seed: string;
  size?: Size;
  /** 圆形裁切。账号头像和成员列表用圆形，员工卡用圆角方片（设计稿如此）。 */
  round?: boolean;
  className?: string;
}

/**
 * 画片参数。
 *
 * - 表情只留平静与微笑：员工卡是「谁在替你干活」，不是表情包。
 * - 衣服限定深灰、黑、藏青、浅灰、灰蓝、棕，都是办公室里说得过去的颜色。
 * - 底色三档几乎一样浅（设计稿里所有头像底色统一为很浅的灰蓝），只留一点点差别避免一整排完全雷同。
 * - scale / translateY 把镜头推近一点并略微上移，让脑袋占满画片、头顶不留一大片空。
 * - randomizeIds：同一页会出现多张头像，SVG 内部的 id 不打散会互相覆盖。
 */
const LOOK: StyleOptions<ToonHeadOptions> = {
  backgroundColor: ['f6efe7', 'f5ece4', 'f7f1ea'],
  mouth: ['smile', 'laugh'],
  eyes: ['happy', 'humble', 'wide'],
  eyebrows: ['neutral', 'raised', 'happy'],
  clothesColor: ['1a1714', '545454', '2f4858', 'e8e4dc', '6b5d52', '8d6e63'],
  beardProbability: 20,
  scale: 112,
  translateY: 4,
  randomizeIds: true,
};

/**
 * 同一个 seed 只生成一次。一次 createAvatar 约 5KB 字符串，
 * 员工墙翻页时同一张脸会反复出现，不缓存等于每次重画。
 */
const cache = new Map<string, string>();

function faceOf(seed: string): string {
  const key = seed || 'sep';
  const known = cache.get(key);
  if (known) return known;
  // preserveAspectRatio 必须自己加：画片是正方形，卡片上的头像片是竖着的圆角矩形，
  // 默认的 meet 会留出上下空白，slice 才是「铺满并居中裁切」。
  // 同名属性出现两次时浏览器取第一个，所以插在最前面一定生效。
  const svg = createAvatar(toonHead, { ...LOOK, seed: key })
    .toString()
    .replace('<svg ', '<svg preserveAspectRatio="xMidYMid slice" ');
  cache.set(key, svg);
  return svg;
}

export function EmployeeFace({ seed, size = 'md', round = false, className }: Props): React.JSX.Element {
  return (
    <span
      className={`ent-face ${size}${round ? ' round' : ''}${className ? ` ${className}` : ''}`}
      aria-hidden
      // 这段 SVG 由 DiceBear 在本地按 seed 画出来，不含任何外部输入的标记，
      // seed 只进 PRNG、不进输出，所以这里没有注入面。
      dangerouslySetInnerHTML={{ __html: faceOf(seed) }}
    />
  );
}
