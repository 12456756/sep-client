# Mac Icon Packaging

The macOS application has two icon representations:

- `build/desktop-icon.icns`: unchanged fallback for older macOS releases.
- `build/mac-icon.icon`: layered Icon Composer source for current macOS. Its
  background is white; `Assets/mark.svg` contains only the transparent brand mark.

The mark uses the geometry from `assets/logo-source/yuanji-A-icon.svg`, on a
1024-pixel canvas. A regression test prevents these two versions from drifting.
Do not add a pre-rendered rounded tile or shadow to the foreground artwork.
Keep the original source, the layered SVG, and the legacy icons consistent when
changing the brand in the future.

## Building From Windows

Icon Composer does not need to run on the developer's Windows computer. The
source directory and JSON can be edited locally. The release workflow selects
Xcode 26 on its macOS runner and runs `scripts/mac-icon.test.mjs` before fetching
the large speech assets. On that runner, the test includes a real Apple compiler
check; on Windows and Linux that specific check is skipped.

During `afterPack`, `scripts/mac-icon.mjs` compiles the source with `xcrun actool`,
copies `Assets.car` into the application's resources, and adds `CFBundleIconName`
to `Info.plist`. This runs before bundle signing and ZIP/DMG creation. It does not
change the application identifier, permissions, version, existing ICNS reference,
Windows icon, or Electron version. Missing compiler outputs stop the build rather
than silently publishing an application without the new icon.

Each target architecture uses its own temporary compiler output. Existing asset
catalogs are not overwritten, and generated temporary files are cleaned up.

## Verification

```powershell
node --test scripts/mac-icon.test.mjs
npm run test:packaging
```

Local mock tests check plist preservation, fallback icons, Windows isolation,
compiler failures, output validation, and workflow integration. They do not
verify Apple's rendering. A successful macOS build confirms compilation and
embedding, not the final Dock appearance. Check Finder and Dock on a real Mac
when one is available; compare a current macOS release and an older one if
possible. A Windows artwork preview is not a native macOS screenshot.

The DMG volume icon remains `build/icon.icns`. That is a separate icon from the
installed application; it is not the source used by Finder or Dock for the app.
