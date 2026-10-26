# Common skills and built-in OfficeCLI

Employee skills keep the platform authorizer, selected-version handling and
immutable package checks. Common skills are a separate host-owned catalog,
prepared by `prepareCommonSkills` immediately before the employee Pi session
is created. They are not inserted into the platform authorization snapshot.

Only employee execution sessions receive the catalog. Planners and tool-disabled
sessions do not start OfficeCLI. Explicit `mcpServers` or `SEP_MCP_CONFIG` replace
defaults, including an empty list; the Office skill is not advertised when its
tool is disabled or unavailable. Missing resources or Office initialization
failure leave unrelated employee tools available and record a policy event.

## Names and integrity

Original files are never renamed or rewritten. Each entry is verified separately
before the SDK's name-based deduplication. Duplicate paths are loaded once.
Common names are retained; colliding employee entries receive stable aliases,
with hashed identity suffixes when necessary. Original non-colliding names are
reserved so a generated alias cannot overwrite another skill. NFKC/case
comparison follows the existing skill contract. A host-side names manifest is
written in the agent directory. Resume also checks the pinned common skill
version/hash and does not silently replace a previously used common skill.

## Office resources

Version: 1.0.156. Run `npm run office:prepare` for the current platform, or
`npm run office:prepare -- darwin arm64` / `darwin x64` for a Mac target.
The official binary hashes and sizes are pinned in `resources/office/manifest.json`.
Executables are ignored in Git, like the existing speech model assets; licenses,
metadata and the adapted skill are committed. Packaging verifies resources and
copies only the target executable in the existing afterPack pipeline, plus the
common skill and notices through extraResources. This avoids the Windows
extraResources transformer re-signing the pinned third-party executable.

The executable is started by absolute path with auto-update and auto-resident
spawning disabled. Each mutation therefore saves before replying; the skill
still requests explicit save/close before delivery. MCP connections follow the
existing session disposal/switch/cancellation lifecycle. Same-file Office calls
are serialized across employee sessions; unrelated files are independent.
Transport interruption closes the Office connection before releasing its file
lock. The returned error asks the model to verify file state; it never retries
an uncertain write. Other MCP tools stay connected.

## Policy

The Office tool is not a generic shell. Arguments are normalized and checked
before approval and again before execution. Reads/writes use the existing task
policy; dependency/attachment grants remain read-only. Existing parents are
canonicalized to catch symlink escapes. File inputs, outputs and image/media
properties are checked. Only inspected inline batches are supported. Unsupported
administration, plugins, raw XML mutation, active/external content, resident and
preview servers are not exposed. Unknown options fail closed with a tool error,
not by terminating the employee task. Writes are never automatically retried.

The existing MCP text/structured-content bridge is unchanged apart from excluding
public Office runtime switches from secret-value redaction. Image results are
not a model visual-verification channel. Existing client previews are unchanged.

## Verification and release limits

Windows real-binary MCP tests exercise docx/xlsx/pptx create/edit/save/readback
and schema validation, as well as blocked writes. Mac target selection is
implemented but still requires real Intel/Apple Silicon execution and signed
bundle validation before release. In particular, re-signing an embedded Mach-O
changes its bytes and can invalidate the pinned binary checksum; the current
runtime fails closed rather than accepting a changed executable. Do not declare
signed macOS Office support verified until this is resolved and tested on macOS.

Local Windows verification:

- Skill/Office/authorization/MCP focused suite: 186 passed.
- Real Pi adapter suite, including common skill enable/disable checks: 44 passed.
- Existing runtime invariants: 182 passed.
- Focused Office/speech/runtime packaging suite: 28 passed, 2 skipped.
- Typecheck, production build, changed-file ESLint, all four SDK POCs and
  tracked-file architecture checks passed.

The full backend run was not green (2126 passed, 25 failed, 1 skipped), including
Windows symlink permission failures, the planner prompt synchronization fixture
and media recovery concurrency. Full packaging also had Windows signing-fixture
failures (108 passed, 5 failed, 5 skipped). Full-project ESLint reported errors
outside this change. These unrelated modules were not modified to suppress their
failures. No installer, clean-machine installation test or model image-result
transport is included in this verification.
