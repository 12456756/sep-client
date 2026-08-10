/**
 * undici-polyfill.ts — Node 20.18.3 兼容补丁
 *
 * undici 8.5.0 要求 Node >=22.19.0，调用了 worker_threads.markAsUncloneable
 * Electron 33 内置 Node 20.18.3，该函数不存在
 *
 * 在 pi-coding-agent 加载前注入 polyfill
 */

import { Worker } from 'worker_threads';

const wt = require('worker_threads') as typeof import('worker_threads') & {
  markAsUncloneable?: (obj: object) => void;
};

if (!wt.markAsUncloneable) {
  console.log('[undici-polyfill] markAsUncloneable not found, injecting polyfill');

  // markAsUncloneable 的作用是标记对象为不可跨线程克隆
  // 在 Node 20 中这个功能不存在，我们提供一个空实现
  // 因为 sep-client 不使用 Worker 线程，这个标记不影响功能
  wt.markAsUncloneable = (obj: object) => {
    // no-op: Electron 主进程不跨线程传递这些对象
  };

  console.log('[undici-polyfill] markAsUncloneable polyfill installed');
}
