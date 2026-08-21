# AGENTS.md

This file provides guidance to Codex when working with code in this repository.

## What this project is

**sep-client** — an Electron desktop client for the Silicon Employee Platform (SEP). Users run
it locally; it connects to the SEP backend and lets them interact with AI employees via a chat
UI. The AI engine is **pi-coding-agent** running **in-process** inside the Electron main process
(not a sidecar).

Architecture in brief: Electron main process owns the pi session lifecycle and all Node/OS APIs;
the renderer (React) only talks to main over contextBridge IPC. There is no direct renderer ↔
pi-coding-agent contact.

## Tech stack

| Area | Choice | Notes |
|------|--------|-------|
| Shell | Electron `^33` | `electron/` = main process |
| AI engine | `@earendil-works/pi-coding-agent` `0.83.0` | **version locked — do not upgrade** |
| Renderer | React 18 + TypeScript | `src/` |
| Build | electron-vite `^2.3` | hot reload in dev |
| Styling | Tailwind CSS 4 + Radix UI primitives | |
| State | Zustand | renderer only |
| PoC runner | tsx | `poc/` scripts, no bundler |

`@earendil-works/pi-ai@0.83.0` is a dev dependency used only in PoC test scripts (`fauxProvider`).

## Commands

```bash
npm run dev         # electron-vite dev mode (hot reload)
npm run build       # production build
npm run typecheck   # tsc check — main process + renderer separately
npm run lint        # eslint

# PoC validation — run before any UI work; all 4 must pass
npm run poc:01      # SDK import + createAgentSession
npm run poc:02      # provider registration + before_provider_headers
npm run poc:03      # async tool_call interceptor
npm run poc:04      # 401 error surfacing
```

## Repo layout

```
sep-client/
├── electron/
│   ├── main.ts          Electron entry, BrowserWindow, IPC handlers
│   ├── preload.ts       contextBridge — the only renderer↔main bridge
│   ├── pi-host.ts       pi session lifecycle (create, prompt, events, destroy)
│   └── credentials.ts   safeStorage wrapper for refresh token
├── pi-extension/
│   ├── index.ts         buildSepExtensions() — assembles extension array
│   ├── guard.ts         provider-neutral tool policy
│   └── provider.ts      provider-neutral authorization header policy
├── src/                 React renderer
│   ├── App.tsx
│   ├── main.tsx
│   └── shared/types.ts  types shared between main and renderer
├── poc/                 standalone validation scripts (tsx, no bundler)
│   ├── fake-gateway.ts  OpenAI-compatible mock server on :9999
│   ├── 01-sdk-import.ts
│   ├── 02-provider.ts
│   ├── 03-tool-call-async.ts
│   └── 04-failure.ts
└── docs/
    └── 交接/            handover documents
```

## pi-coding-agent SDK — verified API (v0.83.0)

These facts were confirmed by reading package types and running PoC scripts.
**The original project handover docs have errors in several of these — trust this section.**

### createAgentSession returns a result object, not a session

```typescript
// correct
const { session, extensionsResult } = await createAgentSession({ ... });

// wrong — crashes or gives an object without .prompt
const session = await createAgentSession({ ... });
```

### DefaultResourceLoader requires cwd + agentDir, and reload() before use

```typescript
// correct
const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),   // required — omitting throws "Cannot read properties of undefined"
  agentDir: '.pi',      // required
  extensionFactories: [myExtension],
  noSkills: true,
  noContextFiles: true,
});
await resourceLoader.reload();  // required — extensions are NOT loaded until this is called
const { session } = await createAgentSession({ resourceLoader, ... });
```

### Session events use subscribe(), not on()

```typescript
// correct
session.subscribe((event) => {
  if (event.type === 'agent_settled') { ... }
  if (event.type === 'agent_end') { console.log(event.willRetry); }
  if (event.type === 'auto_retry_start') { ... }
});

// wrong — session.on() does not exist in v0.83.0
session.on('agent_settled', () => { ... });
```

### ExtensionFactory is a plain function

```typescript
// correct
const myExt: ExtensionFactory = (pi) => {
  // dynamic token — mutate event.headers in place, return value is ignored
  pi.on('before_provider_headers', (event: BeforeProviderHeadersEvent) => {
    event.headers['authorization'] = `Bearer ${token}`;
  });

  // tool approval — must return ToolCallEventResult
  pi.on('tool_call', async (event: ToolCallEvent): Promise<ToolCallEventResult> => {
    const approved = await showApprovalDialog(event);
    return approved ? { block: false } : { block: true, reason: 'user denied' };
  });
};

// wrong
const myExt = { create: () => ({ handlers: { ... } }) };
```

### ModelRuntime

```typescript
const modelRuntime = await ModelRuntime.create({ modelsPath: null });

modelRuntime.registerProvider('sep-gateway', {
  name: 'SEP Gateway',
  baseUrl: process.env['SEP_GATEWAY_URL'],
  apiKey: 'placeholder',    // overwritten per-request by before_provider_headers
  api: 'openai-completions',
  models: [{
    id: 'sep-employee',
    name: 'SEP Employee',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  }],
});

// getModel takes TWO arguments: (providerId, modelId)
const model = modelRuntime.getModel('sep-gateway', 'sep-employee');
if (!model) throw new Error('model not found');
```

## IPC conventions (main ↔ renderer)

All renderer↔main communication goes through `window.electronAPI.*`. The renderer never
imports Electron modules directly. `nodeIntegration: false` always.

```typescript
// electron/main.ts — register handlers
ipcMain.handle('pi:send-prompt', async (_event, text: string) => {
  piHost.sendPrompt(text);
  return { ok: true };
});

// electron/preload.ts — expose minimal surface
contextBridge.exposeInMainWorld('electronAPI', {
  sendPrompt: (text: string) => ipcRenderer.invoke('pi:send-prompt', text),
  onPiEvent: (cb) => {
    const handler = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('pi:event', handler);
    return () => ipcRenderer.removeListener('pi:event', handler);
  },
});

// src/App.tsx — call via window.electronAPI
await window.electronAPI.sendPrompt('hello');
```

Validate all renderer-supplied arguments in main before use. Clean up all `ipcRenderer.on`
listeners on React component unmount via the returned unsubscribe function.

## Security

- Refresh token encrypted at rest via `electron.safeStorage` — see `electron/credentials.ts`
- Token values must never appear in logs, console, or IPC event payloads
- All `bash`, `write`, `edit` tool calls require explicit user approval — SDK hook wiring is isolated in `electron/pi/sdk/`; provider-neutral policy lives in `pi-extension/`
- Unknown tools: block by default; approval timeout 60 s → auto-deny
- Blocked tool calls still reach the provider for the follow-up turn (pi continues the agent loop)

## tsconfig layout

| File | Covers |
|------|--------|
| `tsconfig.node.json` | `electron/` + `pi-extension/` + `poc/` + `scripts/` |
| `tsconfig.web.json` | `src/` (renderer) |
| `tsconfig.json` | root, references both |

Path aliases: `@shared/*` → `./src/shared/*` (main process); `@/*` → `./src/*` (renderer).

The project uses `"type": "module"` in `package.json`. tsx PoC scripts must run in ESM mode —
this is already set; do not remove it.

## Git commits

```
feat(pi-host): add auto-reconnect on session drop
fix(guard): increase approval timeout to 60 s
chore(poc): document API corrections in AGENTS.md
```

Types: `feat` `fix` `refactor` `chore` `docs` `test` `perf`

## Version lock

`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` are pinned at `0.83.0`.
Do not bump these without a dedicated discussion and a full PoC re-run. Every script in
`poc/` must pass after any version change before UI work resumes.
