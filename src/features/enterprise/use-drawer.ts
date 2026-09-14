/**
 * 抽屉的键盘规矩：打开时焦点落进抽屉，Esc 关闭，Tab 在抽屉里循环。
 *
 * 三件事写在一个 hook 里而不是分开：它们共用同一个容器 ref，而且缺任何一件，
 * 抽屉都会变成「视觉上盖住了页面、键盘还留在下面那一页」的半成品。
 *
 * 只在挂载时装一次监听：onClose 通常是行内箭头函数，把它放进依赖里的话每次
 * 重渲染都会重跑一遍 effect，焦点会被抢回第一个控件 —— 抽屉里有输入框时就没法打字了。
 * 所以最新的 onClose 走 ref 传给监听器。
 *
 * EmployeeWorksDrawer 早于这个 hook，自带一份等价实现；新抽屉都用这里的。
 */

import { useEffect, useRef, type RefObject } from 'react';

/** 能接焦点的元素。比只找 button 宽：抽屉里有输入框、文本域和下拉。 */
const FOCUSABLE = [
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function useDrawer(onClose: () => void): RefObject<HTMLElement> {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);

  useEffect(() => { close.current = onClose; });

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const stops = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!stops.length) return;
      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return panel;
}


