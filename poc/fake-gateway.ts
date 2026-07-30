/**
 * poc/fake-gateway.ts — OpenAI-compatible fake gateway for PoC ② and ④.
 *
 * Usage:
 *   npx tsx poc/fake-gateway.ts          # start on port 9999
 *
 * Endpoints:
 *   POST /v1/chat/completions  — streams a minimal SSE response, logs auth header
 *   GET  /log                  — returns captured Authorization headers as JSON
 *   POST /control              — { "mode": "ok" | "401" | "500" } switch response mode
 *   GET  /control              — current mode + captured token count
 */

import express from 'express';

const app = express();
app.use(express.json());

type GatewayMode = 'ok' | '401' | '500';
let mode: GatewayMode = 'ok';
const capturedTokens: string[] = [];

// POST /v1/chat/completions
app.post('/v1/chat/completions', (req, res) => {
  const auth = req.headers['authorization'] ?? '(none)';
  capturedTokens.push(String(auth));
  console.log(`[fake-gateway] ${mode.toUpperCase()} | auth: ${String(auth).slice(0, 48)}`);

  if (mode === '401') {
    res.status(401).json({ error: { message: 'Unauthorized', type: 'invalid_api_key', code: 401 } });
    return;
  }
  if (mode === '500') {
    res.status(500).json({ error: { message: 'Internal Server Error', type: 'api_error', code: 500 } });
    return;
  }

  // Minimal OpenAI streaming SSE response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const id = `chatcmpl-poc-${Date.now()}`;
  const model = ((req.body as Record<string, unknown>)['model'] as string | undefined) ?? 'poc-model';
  const text = `[gateway-ok] auth=${String(auth).slice(7, 28)}`;

  const chunks = [
    { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];

  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
});

// GET /log — inspect captured tokens
app.get('/log', (_req, res) => {
  res.json({ count: capturedTokens.length, tokens: capturedTokens });
});

// POST /control — switch response mode
app.post('/control', (req, res) => {
  const body = req.body as { mode?: string };
  if (body.mode === 'ok' || body.mode === '401' || body.mode === '500') {
    mode = body.mode;
    res.json({ ok: true, mode });
  } else {
    res.status(400).json({ error: 'mode must be "ok", "401", or "500"' });
  }
});

// GET /control — status
app.get('/control', (_req, res) => {
  res.json({ mode, capturedCount: capturedTokens.length });
});

const PORT = 9999;
app.listen(PORT, () => {
  console.log(`\n[fake-gateway] listening on http://localhost:${PORT}`);
  console.log('  POST /v1/chat/completions  LLM endpoint');
  console.log('  POST /control { mode }     switch ok|401|500');
  console.log('  GET  /log                  inspect captured tokens\n');
});
