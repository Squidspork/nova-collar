const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { Arch } = require('builder-util');
exports.default = async context => {
  execFileSync(process.execPath, [join(context.packager.projectDir, 'scripts/prepare-analysis.mjs'),
    '--platform', context.electronPlatformName, '--arch', Arch[context.arch]],
  { cwd: context.packager.projectDir, stdio: 'inherit' });
};
