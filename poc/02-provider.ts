/**
 * poc/02-provider.ts — PoC ②: 自定义 provider + before_provider_headers 动态令牌
 *
 * 验证目标:
 *   1. ModelRuntime.registerProvider() 能注册指向 localhost 的 OpenAI-compatible provider
 *   2. before_provider_headers 事件在每次 HTTP 请求前触发
 *   3. 每次注入不同令牌，fake gateway 能收到不同的 Authorization header
 *
 * Usage: npm run poc:02
 * (无需单独启动 fake-gateway，本脚本内嵌 HTTP server)
 */

import { createServer } from 'node:http';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type ExtensionFactory,
  type BeforeProviderHeadersEvent,
} from '@earendil-works/pi-coding-agent';

// ── 1. Inline HTTP server (port 19999) ───────────────────────────────────────

const capturedTokens: string[] = [];
const PORT = 19999;

const server = createServer((req, res) => {
  const auth = req.headers['authorization'] ?? '(none)';
  capturedTokens.push(String(auth));
  console.log(`  [server] received auth: ${String(auth).slice(0, 48)}`);

  // Consume request body to avoid socket hang
  req.resume();
  req.on('end', () => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');

    const id = `chatcmpl-poc2-${Date.now()}`;
    const chunks = [
      { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
      { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
      { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

function closeServer(): Promise<void> {
  return new Promise(resolve => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

// ── 2. Token rotation for before_provider_headers ────────────────────────────

const tokenQueue = ['sep-token-AAAA', 'sep-token-BBBB'];
let tokenIndex = 0;

const sepExtension: ExtensionFactory = (pi) => {
  console.log('  [extension] factory called, registering before_provider_headers');
  pi.on('before_provider_headers', (event: BeforeProviderHeadersEvent) => {
    const token = tokenQueue[tokenIndex % tokenQueue.length] ?? 'sep-token-fallback';
    tokenIndex++;
    console.log(`  [extension] injecting token: ${token}`);
    event.headers['authorization'] = `Bearer ${token}`;
  });
};

// ── 3. Test runner ────────────────────────────────────────────────────────────

async function waitSettled(session: Awaited<ReturnType<typeof createAgentSession>>['session']): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('prompt timeout after 30s')), 30_000);
    session.subscribe((event) => {
      if (event.type === 'agent_settled') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function main(): Promise<void> {
  console.log('\n=== PoC ②: provider + before_provider_headers ===\n');

  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  console.log(`✓ inline server listening on :${PORT}`);

  // Register ModelRuntime + fake provider
  const modelRuntime = await ModelRuntime.create({ modelsPath: null });

  modelRuntime.registerProvider('sep-gateway-poc', {
    name: 'SEP Gateway (PoC)',
    baseUrl: `http://localhost:${PORT}`,
    apiKey: 'placeholder',        // will be replaced by before_provider_headers
    api: 'openai-completions',
    models: [{
      id: 'poc-model',
      name: 'PoC Model',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 256,
    }],
  });

  const model = modelRuntime.getModel('sep-gateway-poc', 'poc-model');
  if (!model) throw new Error('model not found after registerProvider');
  console.log('✓ provider registered, model resolved:', model.id);

  // Create ResourceLoader and reload
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: '.pi',
    extensionFactories: [sepExtension],
    noExtensions: false,  // 明确启用 extensions
    noSkills: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  console.log('✓ resource loader reloaded');

  // Create session with extension
  const { session } = await createAgentSession({
    modelRuntime,
    model,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    noTools: 'all',
  });
  console.log('✓ session created');

  // Prompt #1
  console.log('\n[prompt 1]');
  const p1 = waitSettled(session);
  session.prompt('say "one"');
  await p1;

  // Prompt #2
  console.log('\n[prompt 2]');
  const p2 = waitSettled(session);
  session.prompt('say "two"');
  await p2;

  // Verify
  console.log('\n[results]');
  console.log('  capturedTokens:', capturedTokens);

  if (capturedTokens.length < 2) throw new Error(`expected ≥2 requests, got ${capturedTokens.length}`);
  if (capturedTokens[0] === capturedTokens[1]) throw new Error('tokens did not rotate — before_provider_headers may not have fired');

  const t0 = capturedTokens[0] ?? '';
  const t1 = capturedTokens[1] ?? '';
  console.log(`  prompt1 token: ${t0}`);
  console.log(`  prompt2 token: ${t1}`);

  if (!t0.includes('sep-token-AAAA')) throw new Error(`expected AAAA in first token, got: ${t0}`);
  if (!t1.includes('sep-token-BBBB')) throw new Error(`expected BBBB in second token, got: ${t1}`);

  console.log('\n✅ PoC ② PASS — before_provider_headers 动态令牌注入 OK\n');
  await closeServer();
}

main().catch((err: unknown) => {
  console.error('\n❌ PoC ② FAIL:', err);
  void closeServer().finally(() => process.exitCode = 1);
});
