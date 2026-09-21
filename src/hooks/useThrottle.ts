import { useEffect, useRef, useState } from 'react';

/**
 * 节流 Hook
 * 限制值的更新频率，在指定时间间隔内最多更新一次
 *
 * @param value - 要节流的值
 * @param interval - 时间间隔（毫秒）
 * @returns 节流后的值
 *
 * @example
 * const scrollPosition = useThrottle(currentScroll, 100);
 * useEffect(() => {
 *   updateUI(scrollPosition);
 * }, [scrollPosition]);
 */
export function useThrottle<T>(value: T, interval: number): T {
  const [throttledValue, setThrottledValue] = useState<T>(value);
  const lastRan = useRef(Date.now());

  useEffect(() => {
    const handler = setTimeout(() => {
      if (Date.now() - lastRan.current >= interval) {
        setThrottledValue(value);
        lastRan.current = Date.now();
      }
    }, interval - (Date.now() - lastRan.current));

    return () => {
      clearTimeout(handler);
    };
  }, [value, interval]);

  return throttledValue;
}
