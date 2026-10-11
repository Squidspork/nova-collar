# Building a release

Use Node.js 22.12+ and a clean checkout. Run `npm ci`, `npm test`, `node --test scripts/ghidra-review.test.mjs`, and `npm run test:app` before packaging. Update both package versions and the changelog. Build each platform from the same commit; never include a developer’s `.novapup` folder or credentials.

## Source releases

Version 0.3.0 is a source release. Keep the upstream copyright and license text,
`NOTICE`, analysis dependency locks, and build recipe in the public checkout.
Generate an attached source ZIP from the tagged commit with `git archive`, not
from the developer's working directory. This excludes ignored downloads, local
settings, investigation results, logs, and signing material. Scan both outgoing
commits and the extracted final ZIP for secrets and private identifiers.

Attach SHA-256 checksums and a reviewed verification summary identifying the
source commit, test scope, and tested engine platforms. Verify the uploaded
asset digests against local hashes. Hashes establish byte integrity, not an
independent security audit or reproducible compilation. Do not publish updater
manifests without their matching verified installers.

## Analysis bundle

Packaging invokes `scripts/prepare-analysis.mjs`, verifies the pinned downloads,
and retains licenses and source. See [software-analysis provenance](software-analysis.md#licenses-and-provenance).
Run `npm run test:analysis:live` against each intended platform's complete bundle
before claiming support. Check the packaged app as well as the development tree.
The 0.3.0 engine was verified on Apple Silicon; Windows, Linux, and Intel Mac
archive entries are build specifications, not validated release artifacts.

## Windows x64

Run `npm run release:win` on Windows. node-pty uses its bundled Node-API binaries. Smoke-test the installer, PowerShell terminal, model selection, and an approval allow/deny flow on disposable files. Publish the exe, zip, blockmap, and `latest.yml`. A Windows build without a Windows signing certificate may show an unknown-publisher prompt.

## Apple Silicon Mac

The complete Apple Silicon app requires macOS 13.5 or newer because of the bundled Node runtime. Install Xcode command-line tools, Python 3, and a Developer ID Application certificate. Configure notarization through `APPLE_KEYCHAIN_PROFILE`, or `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`, or the Apple ID credentials documented in `scripts/notary.cjs`. Keep credentials outside the repository. API issuer is required for a team key; use `APPLE_API_KEY_INDIVIDUAL=1` only for an individual API key.

Run `APPLE_KEYCHAIN_PROFILE=your-profile npm run release` after validating the profile with `xcrun notarytool store-credentials`. The release command requires credentials and a Developer ID identity. Built-in electron-builder notarization is disabled because the explicit app and DMG hooks handle submission and stapling. It strips native debug records before signing, recursively signs native libraries inside dependency JARs, extension ZIPs, and Python wheels, notarizes/staples the app and DMG, then regenerates update blockmaps and checksums from the final bytes. `npm run pack` remains available for development without notarization credentials. The archive signing pass preserves member paths, permissions, licenses, and source; it refreshes wheel RECORD hashes and records changes in `analysis/MAC-PACKAGING-CHANGES.json`. It refuses to alter JARs with Java signatures rather than invalidating those signatures. Before uploading Mac artifacts, verify the app with `codesign --verify --deep --strict`, `spctl --assess --type execute`, and `xcrun stapler validate`; validate the DMG ticket too.

Publish the dmg, zip, blockmaps, and `latest-mac.yml` only after verification. Hashes in updater metadata must match the final uploaded artifacts, including the stapled DMG. Existing app settings stay in the user’s `.novapup` folder during an app update.

## Build paths and archive metadata

Native dependencies can embed the compiler's working directory even when the source tree is clean. Use a neutral build directory and inspect the packaged native binaries, including node-pty's `.node` files and `spawn-helper`, for developer home paths. On macOS, `xcrun strip -S` removes the debug path records found in the old node-pty binaries. Perform that step before signing, then test the packaged terminal. Modifying an already signed app requires fresh signing and notarization.

Optional model archives must use numeric owner/group 0, empty owner/group names, neutral timestamps, and relative paths. Keep only the model, tokenizer, and configuration files needed at runtime. Compare every file's SHA-256 before and after repacking, and inspect the final tar headers as well as its contents before upload. The neutral owner metadata does not change model weights.

The October 2026 cleanup replaced the Laya archive without changing any of its five content files, withdrew the old Mac downloads, and replaced a developer path in historical test fixtures. Existing branch and tag names remain, but commit IDs changed. Existing contributors should preserve any local work and start from a fresh clone before publishing more changes; merging an old clone can restore the removed history. GitHub's retained PR refs, cached URLs, and outside copies may still contain the older metadata.
