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
- In conversation messages, uploaded Word documents can be previewed from the verified task snapshot. PDF and XLSX document preview remains available for task results, not uploaded attachments.
- HTML output is sanitized and rendered in an opaque sandboxed iframe, with scripts and network access disabled. Markdown does not load external images or execute HTML. Spreadsheet formulas are not evaluated; missing cached values are labeled explicitly.
- XLSX parsing retries recognized Open XML namespace prefixes on an in-memory copy when ExcelJS rejects the original representation. Empty worksheets remain selectable and display an empty state. The user's workbook is not rewritten.
- `.html` files keep their source view and open by default in a separate static render mode. It preserves inline CSS and embedded PNG, JPEG and WebP. Scripts, navigation, external files and sibling assets are not loaded; the HTML file is not opened with a `file:` URL.
- Unsupported files retain the existing copy-path action. Image/video previews keep their existing service, state and player behavior.

## Conversation XLSX analysis

The 100,000-character extraction limit is unchanged. In ordinary conversations, `conversation_attachment` can inspect uploaded `.xlsx` files, read a small cell range, and analyze a selected rectangle for counts (including filters), missing values, duplicate keys or grouped counts/sums. These operations use the authorized original snapshot, not the extracted text. They run in a disposable utility process and do not require Python or Excel. Other attachment formats and arrangement execution are unchanged.

Only visible sheets are eligible. Use an explicit range excluding headers and totals. Formula results are read from the workbook cache and are not recalculated; blank cells, cell errors and formulas without cached results are distinguishable. Text identifiers and simple zero-padded number formats preserve leading zeroes for key comparisons. Numeric aggregation uses the stored number, not formatted text. The receipt distinguishes scanned, included and excluded rows, and reports omitted group display separately. Over-budget, cancelled and timed-out queries do not produce a partial aggregate.

The packaged runtime probe exercises preview, extraction and analysis in the ASAR with a prefixed workbook, an empty worksheet, and a synthetic result affected by the last row of a sparse sheet.

## Verification

```text
npx tsx --test electron/controller/document-preview-contract.test.ts electron/data/document-preview-files.test.ts electron/data/document-preview-store.test.ts electron/service/document-preview-service.test.ts electron/runtime/document-preview-converter.test.ts electron/runtime/document-preview-runtime.test.ts
npx tsx scripts/test-document-preview.mjs
npm run test:html-preview:electron
npm run build
node scripts/test-document-preview-electron.mjs
```

The browser check uses an isolated route/IPC fixture, not a fake API installed in the application. It verifies browser-side HTML sanitization as well as rendering. The Electron check forks the built conversion worker in a real utility process; runtime adapter lifecycle and queue behavior are covered by unit tests.

`test:html-preview:electron` exercises the real preview dialog in Electron without a system browser. It uses a fixture for the authorized file response and verifies styled rendering, source mode, resource blocking and Office regression. The Windows and macOS release jobs run the same check.

## Remaining Risks

- Office preview intentionally does not reproduce original page layout, charts or animations; use the original file for final layout review.
- Dependency auditing reports ExcelJS's transitive UUID dependency. No global dependency override or unrelated upgrades are applied here. Parsing remains isolated in disposable utility processes; this is not a replacement for dependency remediation.
- The full backend test suite is not clean on the current Windows environment (link privileges, long temporary paths and timing-sensitive tests). Preview-specific tests, renderer tests and concurrency invariants pass independently.
