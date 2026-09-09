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

# Backend gate — all four must pass after any change under electron/
npm run test:tasks        # every *.test.ts under electron/
npm run test:invariants   # the I1-I9 concurrency invariants + defect regressions
npm run check:boundaries  # layer boundaries, no bare console.*, mojibake detection
npm run build

# PoC validation — run before any UI work; all 4 must pass
npm run poc:01      # SDK import + createAgentSession
npm run poc:02      # provider registration + before_provider_headers
npm run poc:03      # async tool_call interceptor
npm run poc:04      # 401 error surfacing
```

`poc:01..04` is the only automated check of the Electron 33 / undici SDK loading boundary.
Do not skip it after touching `electron/main.ts` or anything under `electron/pi/`.

## Repo layout

The `electron/` tree is layered by responsibility, not by origin. **This is the structure from
`docs/architecture/后端结构重构实施方案.md` §3.2**, which is complete — all 8 phases landed, and
after Phase 8 a naming pass replaced the jargon-heavy file names with plain ones. Put new code
where this tree says it belongs, not where similar code happens to sit today.

Dependencies flow one way. `runtime/` is the only layer allowed to reach `pi/sdk/`:

```
renderer ──IPC──▶ controller/ ──▶ service/ ──▶ { data/ , runtime/ } ──▶ pi/sdk/
                                                        │
                                       { domain/ , errors/ , common/ }   leaf layers
```

Reverse imports are rejected by `npm run check:boundaries`:

| # | Boundary | Status |
|---|----------|--------|
| B1a | `webContents.send` only in `bootstrap/renderer-bridge.ts` | enforced |
| B1b | `ipcMain` and channel literals only in `controller/` | enforced |
| B2 | `service/` must not import `pi/` or `@earendil-works/*` | enforced |
| B3 | `data/` must not import `service/` or `runtime/` | enforced |
| B4 | `common/` is a leaf — imports nothing from the layers above | enforced |

Five more rules in the same script: `errors:no-handwritten-envelope`, `log:no-bare-console`,
`test:every-suite-registered`, `encoding:utf8`, `encoding:mojibake`. All enforced.

```
sep-client/
├── electron/
│   ├── main.ts                  polyfill → assemble → register IPC → window lifecycle
│   ├── preload.ts               contextBridge — the only renderer↔main bridge
│   ├── bootstrap/               assembly and process lifecycle
│   │   ├── build-backend.ts     createBackend() — the single assembly entry point
│   │   ├── main-window.ts       BrowserWindow creation and display
│   │   ├── renderer-bridge.ts   the only main→renderer push exit; owns the window ref
│   │   └── shutdown.ts          two-phase bounded shutdown
│   ├── controller/              validate → call service → convert to envelope
│   │   ├── channels.ts          the single definition point for IPC channel names
│   │   ├── router.ts            table-driven registration + zod + one catch
│   │   ├── request-context.ts   RequestContext: scope + service handles
│   │   └── routes/              33 routes split by domain — auth, task,
│   │                            conversation, workflow, system (+ index.ts)
│   ├── service/                 use cases + authorization. Touches no Pi object,
│   │   │                        sends no IPC, builds no file paths
│   │   ├── task-service.ts
│   │   ├── conversation-service.ts
│   │   ├── workflow-service.ts
│   │   ├── employee-directory.ts     the only platform-directory read point
│   │   ├── employee-authorizer.ts    pure: directory snapshot in, result out
│   │   └── scope-guard.ts            the only scope check
│   ├── data/                    knows scope and data, never whether a task may run
│   │   ├── atomic-file.ts            the only atomic write (.bak + rollback + quarantine)
│   │   ├── scope-path.ts             the only path derivation; owns the scope primitives
│   │   ├── write-chain.ts            per-key serialized writes
│   │   ├── task-store.ts
│   │   ├── task-run-store.ts         run records; owns `.events`
│   │   ├── task-event-store.ts       event log + in-memory sequence cursor
│   │   ├── task-messages.ts          message projection (pure, no fs)
│   │   ├── task-metadata-store.ts
│   │   └── workflow-store.ts
│   ├── domain/                  pure logic, zero IO
│   │   ├── task-state-machine.ts
│   │   ├── workflow-graph.ts
│   │   └── conversation-context.ts
│   ├── runtime/                 execution and scheduling; does not know IPC exists
│   │   ├── task-execution-coordinator.ts  the orchestrator — 8 public methods, pinned
│   │   ├── task-manager.ts      admission + state-machine execution
│   │   ├── run-types.ts         shared vocabulary (zero-dependency type module)
│   │   ├── run-queue.ts         runId-addressed admission queue
│   │   ├── run-workers.ts       worker lifecycle + completion signal
│   │   ├── run-events.ts        event serialization + drain() + derived state
│   │   ├── run-approvals.ts     tool approval (60 s timeout → auto-deny)
│   │   ├── workspace-lock-manager.ts
│   │   ├── conversation-recovery-error.ts
│   │   └── task-notifier.ts     the push interface; implementation injected by bootstrap
│   ├── errors/
│   │   ├── error-codes.ts       the only error-code table:
│   │   │                        code → 中文 message / status / retryable / log level
│   │   ├── app-error.ts
│   │   ├── error-mapper.ts      unknown → envelope, the only mapping point
│   │   └── error-reporter.ts    redacted reporting + process fallback + fatal dialog
│   ├── common/                  platform channel + infrastructure (leaf layer)
│   │   ├── platform/            SEP platform channel (was auth/)
│   │   │   ├── platform-api.ts
│   │   │   ├── auth-session-manager.ts
│   │   │   ├── authentication-required-error.ts
│   │   │   ├── instance-token-manager.ts
│   │   │   ├── instance-directory.ts    TTL + singleflight subscription directory
│   │   │   ├── credential-vault.ts      safeStorage wrapper for the refresh token
│   │   │   └── device-fingerprint.ts
│   │   ├── logger.ts            the only log entry point; bare console.* is rejected
│   │   ├── redact.ts            the only redaction implementation
│   │   ├── load-once.ts         load-once async value, shared by concurrent waiters
│   │   ├── with-timeout.ts      bounded waits
│   │   ├── config.ts            gateway URL, platform base URL, timeouts
│   │   ├── constants.ts         SIDE_EFFECT_TOOLS + hasSideEffects() — one definition
│   │   └── undici-polyfill.ts   must stay main.ts's first side-effect import
│   └── pi/sdk/                  pi SDK types and lifecycle may appear ONLY here
│       ├── pi-coding-agent-adapter.ts   the only file importing @earendil-works/*
│       ├── pi-agent-runtime.ts          SDK-agnostic port contract
│       ├── pi-task-worker.ts
│       ├── pi-shared-session.ts         one pi session reused across conversation turns
│       └── pi-skill-packages.ts         SkillPackageStore: downloads + caches skill packages
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
├── scripts/
│   └── check-boundaries.ts  layer boundaries + no bare console.* + mojibake detection
└── docs/
    ├── architecture/    the authoritative refactor plan (behavioural baseline)
    ├── plans/           feature design documents
    ├── 对接/            platform API integration guides
    └── archive/         superseded documents, kept for history
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

- Refresh token encrypted at rest via `electron.safeStorage` — see `electron/common/platform/credential-vault.ts`
- Token values must never appear in logs, console, or IPC event payloads
- Log only through `electron/common/logger.ts`; every field passes `electron/common/redact.ts`.
  Bare `console.*` in `electron/` fails `npm run check:boundaries`
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
feat(coordinator): add auto-reconnect on session drop
fix(guard): increase approval timeout to 60 s
chore(poc): document API corrections in AGENTS.md
```

Types: `feat` `fix` `refactor` `chore` `docs` `test` `perf`

## Version lock

`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` are pinned at `0.83.0`.
Do not bump these without a dedicated discussion and a full PoC re-run. Every script in
`poc/` must pass after any version change before UI work resumes.

## Electron 33 pi SDK loading boundary

- `pi-coding-agent@0.83.0` bundles `undici@8.5.0`, which expects Node `>=22.19.0`; Electron 33 uses Node 20.
- Keep `import './common/undici-polyfill'` as the **first** import in `electron/main.ts`.
- `TaskExecutionCoordinator` may only be reached through the single dynamic import inside
  `BackendRuntime.loadTaskCoordinator()` (`electron/bootstrap/build-backend.ts`). Everywhere
  else it must be `import type`.
- Do not statically import the coordinator or the pi SDK from anywhere reachable at startup.
  Doing so can crash startup with `markAsUncloneable is not a function`.
- `electron/pi/sdk/sdk-boundary.test.ts` asserts all of the above at the source level; the build
  should still emit `task-execution-coordinator-*.js` as a separate chunk.
- After changing this boundary, run `npm run typecheck`, `npm run test:tasks`, `npm run build`, and all four `poc:*` scripts.

## Frontend UI reference and integration rules

When a renderer UI needs visual improvement, use proven component references as design
inputs instead of inventing every pattern from scratch. The preferred reference sources
are:

- `https://beautifului.dev` for polished interaction and visual patterns.
- `https://beui.dev` for compact application components and layout ideas.
- `https://rareui.com` for distinctive but reusable UI treatments.
- `https://transitions.dev` for restrained transitions and state-change motion.
- `https://ui.shadcn.com` for accessible, composable React component structure.

Follow this workflow:

1. Identify the exact component or interaction needed, then inspect several references
   before choosing one. Prefer an existing repository pattern when it already satisfies
   the requirement.
2. Adapt the reference to the current React, Tailwind, Radix and `lucide-react` stack;
   do not introduce a new UI framework, duplicate an existing primitive, or copy a whole
   page when only one component is needed.
4. Keep business logic, IPC contracts, data loading, and component responsibilities
   unchanged unless the task explicitly requires them. Keep copied presentation code
   free of secrets, remote runtime dependencies, and unnecessary packages.
5. Re-check responsive behavior at `1200x800` and `960x640`. Verify keyboard focus,
   hover/active/disabled/loading/error states, readable contrast, reduced-motion behavior,
   and that long labels do not overlap neighboring controls.
6. Before delivery, run the relevant typecheck/build commands and inspect the rendered
   page with Playwright when the change is visual. Record the reference source and any
   material adaptation in the change summary.

## ECC Workflow Routing

The selected ECC skills are project-local under `.agents/skills/`. Load them only when the
task matches; do not load every skill for every request.

- New features, bug fixes, and refactors: use `$tdd-workflow`.
- Authentication, authorization, IPC input, file access, secrets, or external APIs: use
  `$security-review`.
- Layer boundaries, ports, adapters, or dependency direction: use `$hexagonal-architecture`.
- IPC contracts, request/response envelopes, or service/repository boundaries: use
  `$api-design` and `$backend-patterns`.
- Error codes, retries, timeouts, or failure propagation: use `$error-handling`.
- pi-coding-agent sessions, tool calls, memory, retries, or provider behavior: use
  `$ai-regression-testing`.
- Agent or LLM behavior regressions, wrapper failures, or pre-release agent audits: use
  `$agent-architecture-audit`.
- Significant architecture choices: use `$architecture-decision-records`.
- Before claiming a change is complete: use `$verification-loop`.

Adapt verification to this repository's scripts:

```bash
npm run typecheck
npm run lint
npm run test:tasks
npm run test:invariants
npm run check:boundaries
npm run build
npm run poc:01
npm run poc:02
npm run poc:03
npm run poc:04
```

## ECC Common and TypeScript Coding Standards

The project-specific instructions above take precedence where they are more specific.
Apply the following ECC standards to TypeScript and JavaScript work in this repository.

### Immutability (Critical)

Always create new objects; do not mutate existing application data in place. Immutable
data prevents hidden side effects, makes debugging easier, and supports safe concurrency.

```typescript
// Incorrect: mutates the original object.
user.name = name

// Correct: returns a new object.
const updatedUser = { ...user, name }
```

### Core Principles

- **KISS:** Prefer the simplest solution that satisfies the requirement. Optimize for
  clarity over cleverness and avoid premature optimization.
- **DRY:** Extract genuinely repeated logic into shared functions or utilities. Do not
  introduce speculative abstractions.
- **YAGNI:** Do not build features or generalized extension points before they are needed.
  Start simple and refactor only when actual pressure warrants it.

### File Organization

- Favor focused, cohesive modules with low coupling over large catch-all files.
- Keep source files typically in the 200-400 line range; treat 800 lines as a soft
  maintainability ceiling. Generated, vendored, and test files may exceed this when
  justified.
- Extract utilities from oversized modules.
- Organize code by feature or domain rather than only by technical type.

### Error Handling and Validation

- Handle errors explicitly at every layer; never silently swallow errors.
- Use user-friendly messages in UI-facing code and log detailed, redacted context on the
  main-process side through the repository logger.
- Validate all input at system boundaries, including renderer IPC arguments, API responses,
  and file content.
- Prefer schema-based validation, fail fast with clear messages, and treat external data as
  untrusted.

### Naming and Maintainability

- Use descriptive `camelCase` names for variables and functions.
- Prefix booleans with `is`, `has`, `should`, or `can`.
- Use `PascalCase` for interfaces, types, and components; use `UPPER_SNAKE_CASE` for
  constants.
- Prefer early returns to nested conditionals. Avoid nesting deeper than four levels.
- Replace meaningful magic numbers, delays, and thresholds with named constants.
- Keep functions focused, normally under 50 lines.

Before marking work complete, check that code is readable and well named, functions and files
are focused, errors are handled, values are not hardcoded, and immutable patterns are used.

### TypeScript and JavaScript Types

- Give exported functions, shared utilities, public class methods, shared models, and
  component props explicit parameter and return types.
- Let TypeScript infer obvious local variable types.
- Extract repeated inline object shapes into named types or interfaces.
- Use `interface` for object shapes intended to be extended or implemented.
- Use `type` for unions, intersections, tuples, mapped types, and utility types.
- Prefer string-literal unions to `enum` unless an enum is required for interoperability.
- Avoid `any` in application code. Represent external or untrusted values as `unknown`, then
  narrow them safely. Use generics when the type depends on the caller.

```typescript
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unexpected error'
}
```

### React and JavaScript

- Define React component props with a named `interface` or `type`, including explicit callback
  types. Do not use `React.FC` without a specific reason.
- In `.js` and `.jsx` files, add JSDoc where types materially improve clarity and a TypeScript
  migration is impractical. Keep JSDoc aligned with runtime behavior.

### TypeScript Error Handling and Validation

- Prefer `async`/`await` with `try`/`catch` around asynchronous operations.
- Treat caught errors as `unknown`, narrow them safely, log the original error through
  `electron/common/logger.ts`, and throw a useful error for the caller.
- Use Zod for schema-based validation when a runtime schema is needed; infer TypeScript types
  from the schema rather than maintaining duplicate shapes.

```typescript
import { z } from 'zod'

const userSchema = z.object({
  email: z.string().email(),
  age: z.number().int().min(0).max(150)
})

type UserInput = z.infer<typeof userSchema>
```

### Production Logging

- Do not add `console.log` to production code.
- Use the project's logger and redaction flow. In particular, bare `console.*` calls in
  `electron/` are rejected by `npm run check:boundaries`.
