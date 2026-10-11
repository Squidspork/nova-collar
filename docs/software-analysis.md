# Bundled software analysis

Nova Collar 0.3.0 adds an app-owned REA MCP client over stdio. Normal software
investigations use REA and its headless Ghidra provider. The existing `ghidra_*`
pack remains available for projects open in the user's Ghidra desktop window.
The default route never connects to that GUI or imports into its project.

## User flow

Choose **Software analysis** under Work, or **Settings → software analysis →
choose an app or file**. Submit the prepared request or write a question about
the selected target. Electron app bundles are automatically routed to their
ASAR when present. An explicit `kind` can select native analysis instead.

`analysis_open` returns an investigation ID. `analysis_tools` searches the full
upstream catalog and returns the exact schema for a selected operation.
`analysis_call` invokes audited static operations; `analysis_run` is the explicit
route for remaining operations with runtime or write effects. Upstream provider
availability still applies. This distribution bundles REA and Ghidra, not every
optional Android, firmware, browser, or commercial provider.

Large results are saved intact and read with `analysis_read_result`. Results and
the exported REA Evidence bundle live under `~/.novapup/analysis/<session-id>`.
`analysis_close`, ten minutes of inactivity, and normal app shutdown save the
evidence and close app-owned resources. Cancellation propagates through MCP.
Closing an investigation retains its saved results. Local analysis does not
change which model receives chat/tool data; that remains the user's selection.

## Packaging

Run `npm run analysis:prepare` in a source checkout, or use the ordinary app
packaging commands. The electron-builder `beforePack` hook prepares the bundle
for its target automatically. Nothing is downloaded or installed at runtime.

The build downloads pinned, SHA-256-verified Node, Temurin JDK, Temurin source,
and Ghidra archives. REA and its production dependencies use a checked-in npm
lockfile and `npm ci --ignore-scripts`. REA uses a pinned Node runtime independent
of Electron, so Electron upgrades cannot change the analysis runtime underneath it.

`runtime/analysis/bundle-lock.json` specifies macOS arm64/x64, Linux x64, and
Windows x64 archives. Build and test releases on their target operating systems.
The presence of archive specifications does not establish that a platform was
tested. Windows headless Ghidra remains subject to REA's experimental P0 scope.

macOS release archives omit Ghidra's native decompiler and GNU demanglers. On the
build Mac, the prepare script compiles their unmodified included sources for the
target architecture using Xcode Command Line Tools. Compiler flags are in that script;
the source remains in the distributed Ghidra tree. The packaging/compiler recipe
also accompanies the app in `analysis/sources/prepare-analysis.mjs`.
Installed users need neither a compiler nor a system Java/Node/Ghidra installation. The app's own Java JDK
supplies the compiler needed by Ghidra's Java bridge.

Generated payloads live in `vendor/analysis/<os>-<arch>`, outside app.asar.
Downloads and native build caches live in ignored `work/analysis-downloads`.
Each bundle includes an identity manifest, pinned source/download provenance,
licenses and upstream notices, and the complete Temurin source archive.
Force a rebuild with `node scripts/prepare-analysis.mjs --force`.

## Licenses and provenance

Nova Collar's integration remains Apache-2.0. The independent upstream components
retain their original licenses and attribution; this project does not relicense
them or imply endorsement. No upstream engine source is modified.

| Component | Pinned version | Upstream and retained license material |
| --- | --- | --- |
| REA | 6.4.0 | [morluto/rea](https://github.com/morluto/rea), MIT, copyright 2026 morluto. Original [MIT text](../runtime/analysis/licenses/REA-MIT.txt), plus package licenses and supplementary notices. |
| Ghidra | 12.1.4 | [NSA Ghidra release](https://github.com/NationalSecurityAgency/ghidra/releases/tag/Ghidra_12.1.4_build), Apache-2.0 plus third-party terms, including GPL GNU demanglers. Original license, notices, native source, and build recipe accompany the bundle. |
| Node.js | 24.18.0 | [Official distribution](https://nodejs.org/dist/v24.18.0/), MIT and third-party terms in `node/LICENSE`. |
| Eclipse Temurin | 21.0.12.1+1 | [Adoptium release](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.12.1%2B1), GPLv2 with Classpath Exception and component notices under the JDK's `legal` directory. Complete corresponding upstream source is included in `sources/temurin-jdk-sources.tar.gz`. |
| MCP SDK | 1.32.1 | [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk), MIT. The SDK's license stays with its installed dependency. |

The [bundle lock](../runtime/analysis/bundle-lock.json) records official archive
URLs and SHA-256 hashes. The [runtime npm lock](../runtime/analysis/package-lock.json)
records REA's exact package and dependency integrity values. Nova Collar's main
lockfile pins the SDK. Build scripts verify archive hashes and npm verifies package
integrity. The generated bundle identity hashes the bundle lock, runtime npm lock,
and preparation script; it identifies the recipe, not every output byte. Native
compiler versions and platform signatures may change output bytes.

Settings opens the bundle's `THIRD-PARTY-NOTICES.txt`. Keep the full licenses,
notices, corresponding source, and recipe when distributing a built app. The
0.3.0 public release contains source and build recipes; large engine archives are
downloaded during the build. Signing and notarization remain part of the
[release pipeline](releasing.md).

## Validation

- `npm run test:analysis`: routing, schemas/discovery, target isolation,
  cancellation, evidence persistence, pagination, task holds, and idle cleanup
  against a test MCP peer. This does not claim engine verification.
- `npm run test:analysis:live`: real bundled REA JavaScript analysis and version
  comparison, real compiled fixture decompilation in headless Ghidra, unchanged
  target hashes, evidence export, bundled Java identity, real native cancellation,
  and helper cleanup.
- The original Ghidra skill and function-review tests exercise the project route.

Live receipts are written to `work/analysis-verification/receipt.json`. Set
`NOVA_ANALYSIS_TEST_DIR` to a different scratch directory. Development tests can
set `NOVA_ANALYSIS_BUNDLE` to an extracted bundle; packaged apps ignore that
override and always use their own Resources/analysis directory.

The live check currently targets macOS/Linux developer environments with a C++
compiler and `ps`. Raw receipts contain local target and process paths; publish
only a reviewed summary. The 0.3.0 engine verification was performed on Apple
Silicon. The optional Ghidra desktop-project route is covered by bridge fixtures;
the release does not claim a live test of another user's desktop project or an
end-to-end model evaluation.
