/** Passed only by the built-in browser, never from tool input or IPC. */
export interface BrowserHandoffDetection {
  signal: AbortSignal
  waitForCompletion(signal: AbortSignal): Promise<void>
}
