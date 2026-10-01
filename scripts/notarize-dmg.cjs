// afterAllArtifactBuild hook: sign, notarize, and staple every .dmg so the disk image
// itself passes Gatekeeper. electron-builder leaves the dmg container unsigned, so without
// this a downloaded dmg is "rejected: no usable signature" even though the app inside is fine.
// No-ops unless Apple credentials are set, so npm run pack and credential-less machines skip.
const { authArgs, notarize, staple, signDmg } = require("./notary.cjs");

exports.default = async function afterAllArtifactBuild(buildResult) {
  const dmgs = (buildResult.artifactPaths || []).filter((file) => file.endsWith(".dmg"));
  if (!dmgs.length) return [];

  const auth = authArgs();
  if (!auth) {
    console.log("notarize: no Apple credentials set — skipping the dmg.");
    return [];
  }

  for (const dmg of dmgs) {
    console.log(`notarize: signing the dmg ${dmg}…`);
    signDmg(dmg);
    console.log("notarize: submitting the dmg to Apple (a few minutes)…");
    notarize(dmg, auth);
    console.log("notarize: stapling the dmg…");
    staple(dmg);
    console.log("notarize: dmg done.");
  }
  return [];
};
