# Building a release

Use Node.js 22.12+ and a clean checkout. Run `npm ci` and `npm test` before packaging. Update both package versions and the changelog. Build both platforms from the same commit; never include a developer’s `.novapup` folder or credentials.

## Windows x64

Run `npm run release:win` on Windows. node-pty uses its bundled Node-API binaries. Smoke-test the installer, PowerShell terminal, model selection, and an approval allow/deny flow on disposable files. Publish the exe, zip, blockmap, and `latest.yml`. A Windows build without a Windows signing certificate may show an unknown-publisher prompt.

## Apple Silicon Mac

Install Xcode command-line tools and a Developer ID Application certificate. Configure notarization through `APPLE_KEYCHAIN_PROFILE`, or `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`, or the Apple ID credentials documented in `scripts/notary.cjs`. Keep credentials outside the repository. API issuer is required for a team key; use `APPLE_API_KEY_INDIVIDUAL=1` only for an individual API key.

Run `npm run release`. The hooks sign/notarize/staple the app and DMG when credentials are configured. Without credentials, they skip notarization for local development; that does not produce a verified public Mac release. Before uploading Mac artifacts, verify the app with `codesign --verify --deep --strict`, `spctl --assess --type execute`, and `xcrun stapler validate`; validate the DMG ticket too.

Publish the dmg, zip, blockmaps, and `latest-mac.yml` only after verification. Hashes in updater metadata must match the final uploaded artifacts, including the stapled DMG. Existing app settings stay in the user’s `.novapup` folder during an app update.
