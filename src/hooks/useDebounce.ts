import { useEffect, useState } from 'react';

/**
 * 防抖 Hook
 * 延迟更新值，直到指定的延迟时间后没有新的更改
 *
 * @param value - 要防抖的值
 * @param delay - 延迟时间（毫秒）
 * @returns 防抖后的值
 *
 * @example
 * const searchTerm = useDebounce(inputValue, 300);
 * useEffect(() => {
 *   if (searchTerm) performSearch(searchTerm);
 * }, [searchTerm]);
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}
