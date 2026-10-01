// afterSign hook: notarize the signed .app and staple the ticket so it launches offline.
// No-ops unless Apple credentials are set (see scripts/notary.cjs), so the unsigned dev
// build (npm run pack) and machines without credentials skip cleanly instead of failing.
const { execFileSync } = require("node:child_process");
const { existsSync, unlinkSync } = require("node:fs");
const path = require("node:path");
const { authArgs, notarize, staple } = require("./notary.cjs");

exports.default = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const auth = authArgs();
  if (!auth) {
    console.log("notarize: no Apple credentials set — skipping the app.");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  if (!existsSync(appPath)) {
    console.log(`notarize: no app at ${appPath} — skipping.`);
    return;
  }

  const zipPath = path.join(appOutDir, `${appName}.notarize.zip`);
  console.log(`notarize: packaging ${appName}.app for submission…`);
  execFileSync("ditto", ["-c", "-k", "--keepParent", appPath, zipPath], { stdio: "inherit" });

  try {
    console.log("notarize: submitting the app to Apple (a few minutes)…");
    notarize(zipPath, auth);
    console.log("notarize: stapling the app…");
    staple(appPath);
    console.log("notarize: app done.");
  } finally {
    try { unlinkSync(zipPath); } catch {}
  }
};
