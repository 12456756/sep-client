/**
 * Device Fingerprint Generator
 *
 * Generates a stable device fingerprint based on hardware characteristics.
 * The fingerprint should be consistent across app restarts on the same device.
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
 * Generate device fingerprint from hardware info
 */
function generateFingerprint(): string {
  const data = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model || 'unknown',
    // Note: motherboard serial number requires additional native modules
    // For now, using available Node.js APIs
  ].join('|');

  // SHA256 hash, truncated to 64 characters (API max: 256)
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 64);
}

/**
 * Get or create device fingerprint
 *
 * First call generates and persists the fingerprint.
 * Subsequent calls return the persisted value.
 */
export function getDeviceFingerprint(): string {
  // Try to load from storage first
  if (store.has(FINGERPRINT_KEY)) {
    return store.get(FINGERPRINT_KEY) as string;
  }

  // Generate new fingerprint
  const fingerprint = generateFingerprint();

  // Persist for future use
  store.set(FINGERPRINT_KEY, fingerprint);

  return fingerprint;
}

/**
 * Clear stored fingerprint (for testing/debugging)
 */
export function clearDeviceFingerprint(): void {
  store.delete(FINGERPRINT_KEY);
}
