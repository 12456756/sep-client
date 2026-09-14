/**
 * 设备指纹生成器。
 *
 * 根据硬件特征生成稳定的设备指纹。
 * 同一设备重启应用后应保持指纹一致。
 */

import * as crypto from 'crypto';
import * as os from 'os';
import Store from 'electron-store';

interface StoreSchema {
  device_fingerprint?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const store = new Store<StoreSchema>() as any;
const FINGERPRINT_KEY = 'device_fingerprint' as const;

/**
 * 根据硬件信息生成设备指纹。
 */
function generateFingerprint(): string {
  const data = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model || 'unknown',
 // 注意：主板序列号需要额外的原生模块。
 // 当前先使用现有的 Node.js API。
  ].join('|');

 // 使用 SHA-256 哈希，并截取为 64 个字符（接口上限为 256）。
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 64);
}

/**
 * 获取或创建设备指纹。
 *
 * 第一次调用时生成并持久化指纹。
 * 后续调用直接返回已保存的值。
 */
export function getDeviceFingerprint(): string {
 // 优先尝试从存储中读取。
  if (store.has(FINGERPRINT_KEY)) {
    return store.get(FINGERPRINT_KEY) as string;
  }

 // 生成新的指纹。
  const fingerprint = generateFingerprint();

 // 持久化以供后续使用。
  store.set(FINGERPRINT_KEY, fingerprint);

  return fingerprint;
}

/**
 * 清除已保存的设备指纹（用于测试和调试）。
 */
export function clearDeviceFingerprint(): void {
  store.delete(FINGERPRINT_KEY);
}


