const { authArgs, developerIdApplication } = require("./notary.cjs");
if (process.platform !== "darwin") throw new Error("Build the Mac release on macOS.");
if (!authArgs()) throw new Error("Mac release requires Apple notarization credentials. Set APPLE_KEYCHAIN_PROFILE to a validated Keychain profile; npm run pack remains available for development.");
if (!developerIdApplication()) throw new Error("Mac release requires a Developer ID Application signing identity.");
