import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { denySecretCommand, denySecretPath } from "../src/main/safe.js";
test("public build identity, launcher and default profile are separate from owner dev", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.novaCollarChannel, "public");
  assert.equal(pkg.build.appId, "com.hungrynova.novacollar.public");
  assert.equal(pkg.build.productName, "Nova Collar");
  assert(!Object.hasOwn(pkg.bin, "np"));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", "import {APP_HOME} from './src/main/config.js'; process.stdout.write(APP_HOME)"], { encoding: "utf8", env: { ...process.env, NOVAPUP_HOME: "" } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, join(homedir(), ".nova-collar-public"));
});
test("both public and legacy credential profiles stay blocked", () => {
  for (const profile of [".nova-collar-public", ".novapup"]) {
    assert(denySecretPath(join(homedir(), profile, "env")));
    assert(denySecretCommand(`cat ~/${profile}/env`));
    assert(denySecretCommand(`Get-Content $HOME\\${profile}\\env`));
  }
});
