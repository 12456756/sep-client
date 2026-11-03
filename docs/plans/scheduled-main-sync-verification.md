# Scheduled Tasks: Local Main Integration Closeout

Date: 2026-11-03

## Scope

- Worktree: `codex/worktree-2`.
- Local `main` and `HEAD`: `a0b7d160059053357a9ebaf9caf2370384578033` (0.3.1).
- Retain scheduled definitions, occurrences, attempts, creation interpretation, reusable employee/arrangement plans, scheduling/recovery, IPC and the independent scheduled UI.
- Shared-file differences are limited to scheduled metadata, durable admission, authorization, lifecycle hooks, IPC, navigation and reused settings controls.
- Restore unrelated optional dependency entries in the lockfile; retain only `cron-parser` and its `luxon` dependency additions.
- Do not commit, push, replay existing tasks or restore backup stashes.

## Integration Fixes

- Homepage creation explicitly sends supported settings rather than spreading `RunSettings` and leaking `knowledge` into the strict creation contract.
- Scheduled model selection opts into an in-control portal inside the modal focus scope. Transform-free centering preserves viewport-based popup positioning. Escape dismisses the picker without closing the editor. Other model pickers keep their existing default behavior.
- Connect `TaskRuntime.authorizeScheduledEmployee` to `EmployeeAuthorizer.authorizeScheduled`; keep the manual authorization path unchanged.
- Preserve `AUTH_REQUIRED` when logged out or the authentication scope changes during scheduled authorization instead of reporting an unavailable employee or model.
- Replace the UI smoke test's programmatic option click with actual mouse and keyboard interactions.

Principal implementation files: `electron/bootstrap/build-backend.ts`, `electron/service/employee-authorizer.ts`, `src/components/enterprise/ModelSelector.tsx`, `src/components/enterprise/arrange/RunSettingsDrawer.tsx`, `src/components/enterprise/scheduled/`, `src/styles/scheduled-tasks.css`.

## Verification

- `npm run build`: passed (non-blocking third-party annotation warnings).
- `npm run typecheck`: passed after correcting the new test's Node assertion import.
- `npm run check:boundaries`: passed.
- `npm run test:renderer`: 614 passed.
- `npm run test:invariants`: 211 passed.
- Explicit scheduled controller/data/domain/runtime/service suites, including new authorization coverage: 98 passed.
- Related auth-login, atomic-file, task-store, arrangement-plan, conversation-service and task-service suites: 85 passed.
- `node scripts/test-scheduled-tasks-ui.mjs`: four viewports (1440x900, 1280x620 dark, 760x900, 390x844), actual model selection, creation, editing, planning, enable/pause, result navigation and uncertain-run acknowledgement passed.
- `npm run poc:01`, `poc:02`, `poc:03`, `poc:04`: all passed.
- ESLint on changed/untracked TypeScript and UI smoke files: passed.
- Full `npm run lint`: fails with 40 errors and 5 warnings in files unchanged from local main. Do not change those files as part of this scope.

## Limits

- Full `test:tasks` was not rerun as a complete suite; the scoped backend suites and invariants above were executed.
- No real-cloud unattended execution, live permission-revocation or long-duration OS sleep validation is claimed. Tests use controlled local workers and faults.
- This integration does not diagnose or fix historical model-output truncation or delivery-format failures.
- Process isolation remains deferred as requested.
- Changes remain uncommitted in the worktree.
