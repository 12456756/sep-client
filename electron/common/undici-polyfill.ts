/**
 * undici-polyfill.ts：为 Node 20.18.3 提供兼容补丁。
 *
 * undici 8.5.0 要求 Node >=22.19.0，并调用 worker_threads.markAsUncloneable。
 * Electron 33 内置 Node 20.18.3，该函数不存在。
 *
 * 在加载 pi-coding-agent 前注入兼容实现。
 */

const wt = require('worker_threads') as typeof import('worker_threads') & {
  markAsUncloneable?: (obj: object) => void;
};

if (!wt.markAsUncloneable) {
  console.log('[undici-polyfill] markAsUncloneable not found, injecting polyfill');

  // 该函数只需存在即可；客户端不会跨 Worker 线程传递这些对象。
  wt.markAsUncloneable = (_obj: object) => {
    // 空操作。
  };

  console.log('[undici-polyfill] markAsUncloneable polyfill installed');
}


