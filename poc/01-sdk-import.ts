/**
 * poc/01-sdk-import.ts — PoC ①: SDK import + session init
 *
 * 验证目标:
 *   1. Electron 主进程能 import @earendil-works/pi-coding-agent (无 ESM/CJS 报错)
 *   2. createAgentSession() 能正常 resolve，返回 AgentSession 对象
 *   3. session 对象具备预期的 .prompt / .on 方法
 *
 * Usage: npm run poc:01
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

async function main(): Promise<void> {
  console.log('\n=== PoC ①: SDK import + createAgentSession ===\n');

  // Step 1: verify import resolved (if we get here, no CJS/ESM error)
  console.log('✓ import @earendil-works/pi-coding-agent');

  // Step 2: minimal session — no real model, no network calls
  const { session } = await createAgentSession({
    resourceLoader: new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: '.pi',
      noSkills: true,
      noContextFiles: true,
    }),
    sessionManager: SessionManager.inMemory(),
  });

  console.log('✓ createAgentSession() resolved');
  console.log(`  typeof session           : ${typeof session}`);
  console.log(`  typeof session.prompt    : ${typeof session.prompt}`);
  console.log(`  typeof session.subscribe : ${typeof session.subscribe}`);

  // Verify the session exposes the methods we'll use downstream
  if (typeof session.prompt !== 'function') {
    throw new Error('session.prompt is not a function');
  }
  if (typeof session.subscribe !== 'function') {
    throw new Error('session.subscribe is not a function');
  }

  console.log('\n✅ PoC ① PASS — SDK import + session init OK\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('\n❌ PoC ① FAIL:', err);
  process.exit(1);
});
