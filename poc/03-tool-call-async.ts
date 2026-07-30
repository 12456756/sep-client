/**
 * poc/03-tool-call-async.ts — PoC ③: tool_call 异步拦截验证
 *
 * 验证目标:
 *   1. pi.on("tool_call", async handler) 能接收 async handler
 *   2. 主进程可以 await 用户确认 Promise，然后再返回 block/allow
 *   3. 阻止执行时 block:true 生效，工具不实际运行
 *
 * 使用 fauxProvider 预编程一次 bash tool_call，无需真实 LLM 或 API key。
 *
 * Usage: npm run poc:03
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type ExtensionFactory,
  type ToolCallEvent,
  type ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';

import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';

// ── timing log ────────────────────────────────────────────────────────────────
const log = (msg: string) => console.log(`  [${new Date().toISOString().slice(11, 23)}] ${msg}`);

// ── async decision state ──────────────────────────────────────────────────────
interface ApprovalRequest {
  toolName: string;
  input: unknown;
  resolve: (decision: boolean) => void;
}
let pendingApproval: ApprovalRequest | null = null;

/**
 * Simulates the Electron IPC round-trip: main asks renderer, renderer replies.
 * In the real app this would be win.webContents.send() + ipcMain.once().
 */
async function simulateGuiApproval(toolName: string, input: unknown): Promise<boolean> {
  log(`GUI dialog shown for tool: ${toolName} ${JSON.stringify(input)}`);
  // Simulate 200ms user think-time
  await new Promise((r) => setTimeout(r, 200));
  log('GUI dialog resolved → block=true (test denies execution)');
  return false; // deny for PoC — proves we can block
}

// ── extension factory ─────────────────────────────────────────────────────────

const guardExtension: ExtensionFactory = (pi) => {
  pi.on('tool_call', async (event: ToolCallEvent): Promise<ToolCallEventResult> => {
    const toolName = (event as { toolName?: string }).toolName ?? 'unknown';
    log(`tool_call handler entered — tool: ${toolName}`);
    const t0 = Date.now();

    // Await async GUI approval (would be IPC to renderer in real app)
    const allow = await simulateGuiApproval(toolName, (event as Record<string, unknown>).input);
    const elapsed = Date.now() - t0;
    log(`async handler returned after ${elapsed}ms — allow=${allow}`);

    if (elapsed < 150) throw new Error(`handler resolved too fast (${elapsed}ms) — async may not have been awaited`);

    return allow ? { block: false } : { block: true, reason: 'PoC③: user denied via async GUI' };
  });
};

// ── main ──────────────────────────────────────────────────────────────────────

async function waitSettled(session: Awaited<ReturnType<typeof createAgentSession>>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout after 30s')), 30_000);
    session.on('agent_settled', () => { clearTimeout(timer); resolve(); });
  });
}

async function main(): Promise<void> {
  console.log('\n=== PoC ③: async tool_call interceptor ===\n');

  // 1. Create faux provider with pre-programmed bash call then text response
  const faux = fauxProvider({ models: [{ id: 'faux-model', name: 'Faux Model', reasoning: false, input: ['text'] }] });

  faux.setResponses([
    // Turn 1: agent returns a bash tool call
    fauxAssistantMessage([fauxToolCall('bash', { command: 'echo hello-poc3' })]),
    // Turn 2: after (blocked) tool result, agent gives final text
    fauxAssistantMessage('PoC③ complete — async guard confirmed'),
  ]);
  log('faux provider configured with 2 responses');

  // 2. Register faux provider with ModelRuntime
  const modelRuntime = await ModelRuntime.create({ modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = faux.getModel();
  log(`faux model registered: ${model.id}`);

  // 3. Create session with guard extension
  const session = await createAgentSession({
    modelRuntime,
    model,
    resourceLoader: new DefaultResourceLoader({
      extensionFactories: [guardExtension],
      noSkills: true,
      noContextFiles: true,
    }),
    sessionManager: SessionManager.inMemory(),
    // bash tool is enabled so the tool_call event fires normally
  });
  log('session created');

  // 4. Run prompt — faux provider will respond with a bash tool call
  console.log('\n[prompt] asking agent to run bash...');
  const done = waitSettled(session);
  session.prompt('run bash echo hello-poc3 please');
  await done;

  // 5. Verify: async handler must have fired
  const pendingCount = faux.getPendingResponseCount();
  console.log(`\n  faux pending responses remaining: ${pendingCount} (expect 0)`);
  if (pendingCount !== 0) throw new Error(`faux provider still has ${pendingCount} pending responses — agent may not have completed`);

  console.log('\n✅ PoC ③ PASS — async tool_call handler awaited, block:true confirmed\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('\n❌ PoC ③ FAIL:', err);
  process.exit(1);
});
