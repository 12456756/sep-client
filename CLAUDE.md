# Repository Guidelines

## Project Overview

`sep-client` is an Electron desktop client for SEP. The Electron main process owns OS APIs, Pi sessions, persistence, and task execution; the React renderer communicates with it only through the preload `contextBridge`.

## Repository Structure

- `electron/`: main-process code, organized into `controller/`, `service/`, `data/`, `domain/`, `runtime/`, `errors/`, `common/`, and `pi/sdk/`.
- `src/`: React renderer and shared renderer types.
- `pi-extension/`: provider-neutral Pi extensions and tool/provider policies.
- `poc/`: standalone Pi SDK and Electron/Node compatibility checks.
- `scripts/`: repository validation and build helpers.
- `docs/`: architecture, plans, integration notes, and historical material.

## Architecture Boundaries

Keep dependencies flowing in one direction:

```text
renderer → controller → service → data/runtime → pi/sdk
```

- `controller/` owns IPC registration, input validation, and response envelopes.
- `service/` contains use cases and authorization; it must not import Pi SDK objects or build file paths.
- `data/` owns persistence and scope paths; it must not depend on `service/` or `runtime/`.
- `runtime/` is the only application layer allowed to reach `pi/sdk/`.
- `webContents.send` belongs only in `bootstrap/renderer-bridge.ts`; channel names belong in `controller/channels.ts`.
- Use the existing architecture in `docs/architecture/` as the source of truth; do not revive superseded layouts.

## Runtime and Dependency Constraints

- Keep `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` at `0.83.0` unless a dedicated migration is approved.
- Keep `import './common/undici-polyfill'` as the first side-effect import in `electron/main.ts`.
- Load `task-runtime` and Pi SDK code through the existing dynamic-import boundary; do not statically load them from startup code.
- Consult `electron/pi/sdk/` and its tests for SDK usage instead of guessing from old documentation.

## Security and IPC

- Renderer input is untrusted: validate every IPC argument and external response at the boundary.
- Never expose refresh tokens or other secrets in logs, IPC payloads, errors, or UI state.
- Log through `electron/common/logger.ts` and redact through the shared redaction flow; bare `console.*` in `electron/` is not allowed.
- Unknown or side-effecting tools require the existing approval policy; approval timeout is an automatic denial.
- Preserve `nodeIntegration: false` and the minimal preload API. Remove renderer event listeners on unmount.

## Commands and Verification

```bash
npm run dev                 # development app with hot reload
npm run typecheck           # renderer and Node/Electron TypeScript checks
npm run lint                # ESLint
npm run build               # production renderer/main build
npm run test:renderer       # renderer tests
npm run test:tasks          # backend unit tests
npm run test:invariants     # concurrency and regression tests
npm run check:boundaries    # dependency, logging, and encoding checks
npm run poc:01              # SDK import boundary
npm run poc:02              # provider registration and headers
npm run poc:03              # async tool interception
npm run poc:04              # failure/401 propagation
```

Run checks relevant to the changed area. Changes to `electron/main.ts`, `electron/pi/`, or startup/runtime loading require all four POCs plus `typecheck` and `build`. Changes to runtime concurrency should also run `test:invariants`; changes to IPC or layer structure should run `check:boundaries`.

## Coding and Git Conventions

Use TypeScript strictness, explicit types for exported APIs, `unknown` for untrusted data, Zod at runtime boundaries, and immutable updates for application state. Follow existing naming and component patterns; avoid speculative abstractions and unnecessary dependencies. SDK event objects may be mutated only where the SDK contract explicitly requires it.

Use Conventional Commits, for example `fix(runtime): handle task cancellation`. Do not commit, push, or modify unrelated user changes. Before claiming completion, report the files changed, checks run, and any remaining risk.

## Communication Style

Keep model output concise and action-oriented: lead with the conclusion, then list only the necessary changes, evidence, and risks. Prefer short bullets over long explanations, avoid repeating context or dumping full logs, and expand only when the user asks or when safety and verification require detail.
