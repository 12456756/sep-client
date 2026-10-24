# Node Delivery Preview

Document preview is an independent, read-only consumer of arrangement deliveries.
It does not change delivery validation, dependency scheduling, task status or media APIs.

- A completed node's accepted files are available while parallel or dependent nodes run.
- Renderer requests identify a task, node and deliverable, never an arbitrary path.
- The data adapter joins the confirmed plan and checkpoint in the authenticated owner scope.
- Snapshots are preferred. Legacy originals must still match the accepted hash; preview never runs workspace recovery or writes a replacement snapshot.
- Every open checks the file integrity. Conversion is cached in a bounded, owner-scoped memory cache by accepted content version, then cleared on logout/shutdown.
- Office parsing runs in disposable Electron utility processes, serialized independently of task execution. A parser timeout/crash only fails the preview.
- PDF renders one page at a time in a browser worker. CMaps and standard fonts ship locally. Office preview presents content, not original pagination or chart fidelity.
- HTML output is sanitized and rendered in an opaque sandboxed iframe, with scripts and network access disabled. Markdown does not load external images or execute HTML. Spreadsheet formulas are not evaluated; missing cached values are labeled explicitly.
- Unsupported files retain the existing copy-path action. Image/video previews keep their existing service, state and player behavior.

## Verification

```text
npx tsx --test electron/controller/document-preview-contract.test.ts electron/data/document-preview-files.test.ts electron/data/document-preview-store.test.ts electron/service/document-preview-service.test.ts electron/runtime/document-preview-converter.test.ts electron/runtime/document-preview-runtime.test.ts
npx tsx scripts/test-document-preview.mjs
npm run build
node scripts/test-document-preview-electron.mjs
```

The browser check uses an isolated route/IPC fixture, not a fake API installed in the application. It verifies browser-side HTML sanitization as well as rendering. The Electron check forks the built conversion worker in a real utility process; runtime adapter lifecycle and queue behavior are covered by unit tests.

## Remaining Risks

- Office preview intentionally does not reproduce original page layout, charts or animations; use the original file for final layout review.
- Dependency auditing reports ExcelJS's transitive UUID dependency. No global dependency override or unrelated upgrades are applied here. Parsing remains isolated in disposable utility processes; this is not a replacement for dependency remediation.
- The full backend test suite is not clean on the current Windows environment (link privileges, long temporary paths and timing-sensitive tests). Preview-specific tests, renderer tests and concurrency invariants pass independently.
