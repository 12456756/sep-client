# Local update-feed fixtures

The beta (0.1.3-beta.1) and stable (0.1.2) feeds each reference macOS arm64/x64 ZIPs and a Windows x64 EXE. All artifacts are tiny plain-text fake files, not installable packages or ZIP archives. Their sizes and SHA512 digests are real and distinct across channels.

Use only for manifest, anonymous HTTP, channel isolation, and download integrity tests. They do not validate CDN caching, code signing, notarization, NSIS installation, or restart installation.

Run from the repository root:

```sh
node scripts/verify-update-manifest.mjs scripts/fixtures/update-feed/beta --require-all-platforms
node scripts/verify-update-manifest.mjs scripts/fixtures/update-feed/stable --require-all-platforms
node --test scripts/update-manifest.test.mjs
```

For the remote CLI, serve this directory on a loopback HTTP fixture server and use `node scripts/test-update-feed.mjs http://127.0.0.1:<port>/beta/ --allow-local-http --require-all-platforms`. Real update sources must use HTTPS.
