#!/usr/bin/env node
// Build-time only. End users never invoke npm, install Java, or download engines.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { cp, chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const platform = arg('--platform', process.platform);
const arch = arg('--arch', process.arch);
const key = `${platform}-${arch}`;
const specDir = join(root, 'runtime/analysis');
const lockText = await readFile(join(specDir, 'bundle-lock.json'), 'utf8');
const lock = JSON.parse(lockText);
const target = lock.targets[key];
if (!target) throw new Error(`No verified analysis bundle specification for ${key}`);
const dependencyLock = await readFile(join(specDir, 'package-lock.json'));
const identity = createHash('sha256').update(lockText).update(dependencyLock)
  .update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
const os = { darwin: 'mac', win32: 'win', linux: 'linux' }[platform];
const out = join(root, `vendor/analysis/${os}-${arch}`);
const cache = join(root, 'work/analysis-downloads');
await mkdir(cache, { recursive: true });
if (!args.includes('--force') && existsSync(join(out, 'manifest.json'))) {
  const old = JSON.parse(await readFile(join(out, 'manifest.json')));
  if (old.identity === identity && [old.node, old.entry, old.java, old.ghidra].every(p => existsSync(join(out, p)))) {
    console.log(`Analysis bundle ready: ${key}`);
    process.exit(0);
  }
}
const stage = `${out}.staging-${process.pid}`;
await mkdir(stage, { recursive: true });
async function sha(file) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest('hex');
}
async function download(item) {
  const file = join(cache, `${item.sha256}-${basename(new URL(item.url).pathname)}`);
  if (existsSync(file) && await sha(file) === item.sha256) return file;
  console.log(`Downloading ${basename(new URL(item.url).pathname)}`);
  const response = await fetch(item.url, { signal: AbortSignal.timeout(900_000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${item.url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${file}.part`));
  if (await sha(`${file}.part`) !== item.sha256) throw new Error(`Checksum mismatch: ${item.url}`);
  await rename(`${file}.part`, file);
  return file;
}
async function run(command, argv, cwd = root) {
  await new Promise((yes, no) => {
    const child = spawn(command, argv, { cwd, stdio: 'inherit', shell: false, windowsHide: true });
    child.once('error', no);
    child.once('exit', code => code === 0 ? yes() : no(new Error(`${command} exited ${code}`)));
  });
}
async function unpack(file, name) {
  const temp = join(stage, `unpack-${name}`);
  await mkdir(temp);
  if (file.endsWith('.zip')) {
    if (process.platform === 'darwin') await run('/usr/bin/ditto', ['-x', '-k', file, temp]);
    else if (process.platform === 'win32') await run('tar', ['-xf', file, '-C', temp]);
    else await run('unzip', ['-q', file, '-d', temp]);
  }
  else await run('tar', ['-xzf', file, '-C', temp]);
  const entries = (await readdir(temp)).filter(x => x !== '__MACOSX');
  if (entries.length !== 1) throw new Error(`Expected one archive root in ${name}`);
  await rename(join(temp, entries[0]), join(stage, name));
  await rm(temp, { recursive: true });
}
try {
  const [node, java, ghidra, javaSource] = await Promise.all([
    download(target.node), download(target.java), download(lock.ghidra), download(lock.java_source),
  ]);
  await unpack(node, 'node');
  await unpack(java, 'java');
  await unpack(ghidra, 'ghidra');
  await mkdir(join(stage, 'sources'));
  await cp(javaSource, join(stage, 'sources/temurin-jdk-sources.tar.gz'));
  await cp(fileURLToPath(import.meta.url), join(stage, 'sources/prepare-analysis.mjs'));
  await mkdir(join(stage, 'rea'));
  for (const f of ['package.json', 'package-lock.json']) await cp(join(specDir, f), join(stage, 'rea', f));
  // npm executes on the build host, but resolves optional dependencies for the target.
  const npmCli = process.env.npm_execpath || join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  await run(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${platform}`, `--cpu=${arch}`], join(stage, 'rea'));
  const javaHome = platform === 'darwin' ? 'java/Contents/Home' : 'java';
  const manifest = {
    schema_version: 1, identity, target: key, versions: {
      rea: lock.rea_version, ghidra: lock.ghidra_version, node: lock.node_version, java: lock.java_version,
    },
    node: platform === 'win32' ? 'node/node.exe' : 'node/bin/node',
    entry: 'rea/node_modules/rea-agents/scripts/rea.mjs',
    java: `${javaHome}/bin/java${platform === 'win32' ? '.exe' : ''}`,
    java_home: javaHome, ghidra: 'ghidra',
  };
  const nativeDir = { 'darwin-arm64': 'mac_arm_64', 'darwin-x64': 'mac_x86_64', 'linux-x64': 'linux_x86_64', 'win32-x64': 'win_x86_64' }[key];
  const decompiler = `ghidra/Ghidra/Features/Decompiler/os/${nativeDir}/decompile${platform === 'win32' ? '.exe' : ''}`;
  if (!existsSync(join(stage, decompiler)) && platform === 'darwin') {
    if (process.platform !== 'darwin') throw new Error('Build macOS native engines on a Mac with Xcode Command Line Tools.');
    const built = join(cache, `decompile-${lock.ghidra.sha256}-${arch}`);
    if (!existsSync(built)) {
      console.log(`Building Ghidra's unmodified native decompiler for ${arch}`);
      await run('make', ['-s', '-j6', 'ghidra_opt', `OSDIR=${nativeDir}`, 'OPT_CXXFLAGS=-O2',
        `ARCH_TYPE=-arch ${arch === 'arm64' ? 'arm64' : 'x86_64'}`, 'ADDITIONAL_FLAGS=-mmacosx-version-min=12.0',
        'CXX=clang++ -std=c++11'], join(stage, 'ghidra/Ghidra/Features/Decompiler/src/decompile/cpp'));
      await cp(join(stage, 'ghidra/Ghidra/Features/Decompiler/src/decompile/cpp/ghidra_opt'), built);
    }
    await mkdir(dirname(join(stage, decompiler)), { recursive: true });
    await cp(built, join(stage, decompiler));
    // Build products are not needed at runtime; retain the upstream source and Makefile.
    await rm(join(stage, 'ghidra/Ghidra/Features/Decompiler/src/decompile/cpp/ghi_opt'), { recursive: true, force: true });
    await rm(join(stage, 'ghidra/Ghidra/Features/Decompiler/src/decompile/cpp/ghidra_opt'), { force: true });
  }
  const demanglers = [];
  for (const version of ['2_24', '2_41']) {
    const name = `demangler_gnu_v${version}`;
    const relative = `ghidra/GPL/DemanglerGnu/os/${nativeDir}/${name}${platform === 'win32' ? '.exe' : ''}`;
    demanglers.push(relative);
    if (!existsSync(join(stage, relative)) && platform === 'darwin') {
      const built = join(cache, `${name}-${lock.ghidra.sha256}-${arch}`);
      if (!existsSync(built)) {
        const source = join(stage, 'ghidra/GPL/DemanglerGnu/src', name);
        const inputs = (await readdir(join(source, 'c'))).filter(f => f.endsWith('.c')).sort().map(f => join(source, 'c', f));
        console.log(`Building Ghidra's unmodified GNU demangler ${version} for ${arch}`);
        await run('clang', ['-O2', '-std=gnu17', '-arch', arch === 'arm64' ? 'arm64' : 'x86_64',
          '-mmacosx-version-min=12.0', '-DHAVE_STDLIB_H', '-DHAVE_STRING_H',
          ...(version === '2_24' ? ['-DMAIN_CPLUS_DEM'] : []),
          '-I', join(source, 'headers'), ...inputs, '-o', built]);
      }
      await mkdir(dirname(join(stage, relative)), { recursive: true });
      await cp(built, join(stage, relative));
    }
  }
  manifest.native_tools = [decompiler, ...demanglers];
  for (const p of [manifest.node, manifest.entry, manifest.java, ...manifest.native_tools]) {
    if (!existsSync(join(stage, p))) throw new Error(`Missing runtime component: ${p}`);
  }
  await mkdir(join(stage, 'licenses'));
  await cp(join(stage, 'rea/node_modules/rea-agents/LICENSE'), join(stage, 'licenses/REA-MIT.txt'));
  await cp(join(stage, 'ghidra/LICENSE'), join(stage, 'licenses/Ghidra-Apache-2.0.txt'));
  await cp(join(root, 'LICENSE'), join(stage, 'licenses/Nova-Collar-Apache-2.0.txt'));
  await writeFile(join(stage, 'THIRD-PARTY-NOTICES.txt'), `Nova Collar Software Analysis\n\nNova Collar: Copyright 2026 Hungry Nova Labs, Apache-2.0.\nREA ${lock.rea_version}: Copyright (c) 2026 morluto, MIT. https://github.com/morluto/rea\nGhidra ${lock.ghidra_version}: Apache-2.0, with additional components under their own licenses. https://github.com/NationalSecurityAgency/ghidra\nNode ${lock.node_version}: MIT and third-party notices in node/LICENSE. https://nodejs.org\nEclipse Temurin ${lock.java_version}: GPLv2 with the Classpath Exception and third-party notices in ${javaHome}/legal. Complete corresponding upstream source accompanies this distribution in sources/temurin-jdk-sources.tar.gz.\n\nREA dependencies retain their package licenses in rea/node_modules. REA includes supplementary notices under its third_party and licenses directories. Ghidra's licenses, NOTICE files, and GPL source components remain in the ghidra distribution. No upstream engine source is modified. The package lock records every npm dependency and integrity.\n\nPackaging and integration by Hungry Nova Labs. Upstream projects do not endorse Nova Collar.\n`);
  await cp(join(specDir, 'bundle-lock.json'), join(stage, 'bundle-lock.json'));
  // Some upstream JDK files are read-only. The app's packaging/signing tools
  // need owner-write access; contents and executable bits remain unchanged.
  async function ownerWritable(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await ownerWritable(file);
      else if (entry.isFile()) { const info = await lstat(file); await chmod(file, info.mode | 0o200); }
    }
  }
  await ownerWritable(stage);
  await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  // Replace only a complete, validated bundle. Preserve the old one until then.
  const previous = `${out}.previous`;
  await rm(previous, { recursive: true, force: true });
  if (existsSync(out)) await rename(out, previous);
  await rename(stage, out);
  await rm(previous, { recursive: true, force: true });
  console.log(`Prepared ${key}: REA ${lock.rea_version}, Ghidra ${lock.ghidra_version}, bundled Node and JDK.`);
} catch (error) {
  await rm(stage, { recursive: true, force: true });
  throw error;
}
