# Packaged Task Runtime Verification

## Failure and Fix

The task worker dynamically imports
`@earendil-works/pi-ai/api/openai-completions`. A development dependency is
omitted from the application root during packaging. A private copy under
`pi-coding-agent/node_modules` cannot satisfy an import from `out/main/chunks`.

`pi-ai` is now a direct production dependency pinned to `0.83.0`. The lockfile
also marks its dependency graph for production; no package versions changed.

## Packaging Gate

The existing `afterPack` hook now runs `verify-packaged-runtime.mjs` before
offline speech verification. It rejects an archive when:

- The application does not declare the pinned production dependency.
- The root provider package is missing or has the wrong version.
- The task worker is missing.
- Electron cannot resolve and import the provider from the worker directory.
- The import resolves outside the archive or lacks the `streamSimple` export.

The probe uses the project's installed Electron in Node mode, with inherited
`NODE_OPTIONS` and `NODE_PATH` removed. It loads the provider and its eager
transitive imports directly from `app.asar`. It does not extract the archive
or start the application, request credentials, or contact a model service.

## Commands

```bash
npm run test:packaging
npm run verify:packaged-runtime -- /absolute/path/to/app.asar
```

The tests use small temporary ASAR fixtures and real Electron subprocesses.
They cover successful imports, Chinese names and spaces, nested-only layouts,
missing transitive imports, broken exports, development-only dependencies,
version mismatches, and both macOS and Windows resource directory layouts.

## Limits

Cross-platform verification loads JavaScript under the build host's Electron.
It does not replace native startup tests on each target architecture or an
end-to-end image generation request. Existing installers remain broken until
rebuilt and distributed. This change does not rebuild or upload installers.
