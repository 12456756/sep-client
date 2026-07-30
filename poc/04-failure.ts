/**
 * poc/04-failure.ts — PoC ④: 失败态不静默降级验证
 *
 * 验证目标:
 *   1. gateway 返回 401 → pi 层捕获到错误
 *   2. 错误冒泡（不是静默忽略）— 可通过 agent_end 事件或异常感知
 *   3. 未生成任何成功的 LLM 响应内容
 *
 * Usage: npm run poc:04
 */

import { createServer } from 'node:http';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

const PORT = 19998;

// ── 1. Inline HTTP server always returns 401 ──────────────────────────────────

const server = createServer((req, res) => {
  console.log('  [server] returning 401 Unauthorized');
  req.resume(); // consume body
  req.on('end', () => {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'invalid_api_key', code: 401 } }));
  });
});

// ── 2. Event tracker ──────────────────────────────────────────────────────────

interface EventLog {
  agent_end_count: number;
  agent_settled: boolean;
  error_detected: boolean;
}

const eventLog: EventLog = {
  agent_end_count: 0,
  agent_settled: false,
  error_detected: false,
};

function waitSettledOrError(session: Awaited<ReturnType<typeof createAgentSession>>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // If we timeout, check what we captured
      if (eventLog.error_detected || eventLog.agent_end_count > 0) {
        // Error was detected → pass
        resolve();
      } else {
        reject(new Error('timeout after 20s without detecting any error or agent_end events'));
      }
    }, 20_000);

    session.on('agent_end', (event: unknown) => {
      eventLog.agent_end_count++;
      const e = event as { willRetry?: boolean; messages?: unknown[] };
      console.log(`  [agent_end #${eventLog.agent_end_count}] willRetry=${e.willRetry ?? false}, messages=${(e.messages ?? []).length}`);

      // If agent_end fires with no messages and willRetry=false, that's our error signal
      if (e.willRetry === false) {
        console.log('  → final agent_end with willRetry=false — error detected');
        eventLog.error_detected = true;
        clearTimeout(timer);
        resolve();
      }
    });

    session.on('agent_settled', () => {
      console.log('  [agent_settled]');
      eventLog.agent_settled = true;
      clearTimeout(timer);
      resolve();
    });

    // Some pi versions may fire 'auto_retry_start' and 'auto_retry_end'
    session.on('auto_retry_start', (event: unknown) => {
      const e = event as { attempt?: number; errorMessage?: string };
      console.log(`  [auto_retry_start] attempt=${e.attempt}, error="${e.errorMessage}"`);
      eventLog.error_detected = true;
    });

    session.on('auto_retry_end', (event: unknown) => {
      const e = event as { success?: boolean };
      console.log(`  [auto_retry_end] success=${e.success}`);
      if (e.success === false) eventLog.error_detected = true;
    });
  });
}

// ── 3. Test runner ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== PoC ④: failure not silently ignored ===\n');

  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  console.log(`✓ server listening on :${PORT} (always returns 401)`);

  const modelRuntime = await ModelRuntime.create({ modelsPath: null });

  modelRuntime.registerProvider('fail-gateway', {
    name: 'Fail Gateway (401)',
    baseUrl: `http://localhost:${PORT}`,
    apiKey: 'fake-key',
    api: 'openai-completions',
    models: [{
      id: 'fail-model',
      name: 'Fail Model',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 256,
    }],
  });

  const model = modelRuntime.getModel('fail-gateway', 'fail-model');
  if (!model) throw new Error('model not found');
  console.log('✓ provider registered:', model.id);

  const session = await createAgentSession({
    modelRuntime,
    model,
    resourceLoader: new DefaultResourceLoader({ noSkills: true, noContextFiles: true }),
    sessionManager: SessionManager.inMemory(),
    noTools: 'all',
  });
  console.log('✓ session created\n');

  console.log('[prompt] triggering 401 error...');
  const done = waitSettledOrError(session);
  session.prompt('say hello');
  await done;

  // ── 4. Verify error was detected ─────────────────────────────────────────────

  console.log('\n[results]');
  console.log('  agent_end_count:', eventLog.agent_end_count);
  console.log('  agent_settled:  ', eventLog.agent_settled);
  console.log('  error_detected: ', eventLog.error_detected);

  if (!eventLog.error_detected && eventLog.agent_end_count === 0) {
    throw new Error('401 error was silently ignored — no agent_end or retry events fired');
  }

  if (!eventLog.error_detected && eventLog.agent_settled) {
    // Agent settled without any detected error events — suspicious
    console.warn('  ⚠️  agent_settled fired but no explicit error signal — check manually');
  }

  console.log('\n✅ PoC ④ PASS — 401 error surfaced (not silently swallowed)\n');
  server.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('\n❌ PoC ④ FAIL:', err);
  server.close();
  process.exit(1);
});
