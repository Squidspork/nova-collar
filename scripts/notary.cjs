// Shared Apple notarization helpers for the electron-builder hooks.
// Credentials come from the environment (App Store Connect API key preferred):
//   APPLE_API_KEY=/path/to/AuthKey_XXXX.p8  APPLE_API_KEY_ID=XXXX  APPLE_API_ISSUER=<uuid>
//   or  APPLE_KEYCHAIN_PROFILE=<notarytool-profile>
//   Individual API keys: omit issuer and set APPLE_API_KEY_INDIVIDUAL=1.
//   or  APPLE_ID=<email>  APPLE_APP_SPECIFIC_PASSWORD=<pw>  APPLE_TEAM_ID=<team>
const { execFileSync } = require("node:child_process");

// notarytool auth arguments, or null when no full credential set is present.
function authArgs() {
  if (process.env.APPLE_KEYCHAIN_PROFILE) return ["--keychain-profile", process.env.APPLE_KEYCHAIN_PROFILE];
  const keyPath = process.env.APPLE_API_KEY;
  const keyId = process.env.APPLE_API_KEY_ID;
  const issuer = process.env.APPLE_API_ISSUER;
  if (keyPath && keyId && issuer) {
    return ["--key", keyPath, "--key-id", keyId, "--issuer", issuer];
  }
  if (keyPath && keyId && process.env.APPLE_API_KEY_INDIVIDUAL === "1") return ["--key", keyPath, "--key-id", keyId];
  const appleId = process.env.APPLE_ID;
  const password = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (appleId && password && teamId) {
    return ["--apple-id", appleId, "--password", password, "--team-id", teamId];
  }
  return null;
}

function notarize(filePath, auth) {
  execFileSync("xcrun", ["notarytool", "submit", filePath, ...auth, "--wait"], { stdio: "inherit" });
}

function staple(filePath) {
  execFileSync("xcrun", ["stapler", "staple", filePath], { stdio: "inherit" });
}

// The "Developer ID Application" identity in the keychain, or "" if none is present.
function developerIdApplication() {
  try {
    const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    const line = out.split("\n").find((row) => row.includes("Developer ID Application"));
    return line ? line.replace(/^.*"(.+)".*$/, "$1") : "";
  } catch {
    return "";
  }
}

function signDmg(dmgPath) {
  const identity = developerIdApplication();
  if (!identity) throw new Error("No Developer ID Application identity in the keychain to sign the dmg.");
  execFileSync("codesign", ["--force", "--sign", identity, "--timestamp", dmgPath], { stdio: "inherit" });
}

module.exports = { authArgs, notarize, staple, signDmg, developerIdApplication };
