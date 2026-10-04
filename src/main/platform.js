import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const isWindows = process.platform === "win32";
export const shellHint = isWindows
  ? "This system runs Windows. host_run and term_send use Windows PowerShell 5.1. Use PowerShell syntax and Windows paths; do not use bash, zsh, or Unix utilities."
  : `This system runs ${process.platform}. Use POSIX shell commands.`;

export function quoteShell(value, windows = isWindows) {
  return windows ? `'${String(value).replaceAll("'", "''")}'` : `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function cdCommand(path) {
  return isWindows ? `Set-Location -LiteralPath ${quoteShell(path)}` : `cd -- ${quoteShell(path)}`;
}

export function shellLaunch(command) {
  if (isWindows) {
    const file = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (command === undefined) return { file, args: ["-NoLogo", "-NoProfile"] };
    const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;\n${command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
    return { file, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] };
  }
  const file = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  return { file, args: command === undefined ? ["-l"] : ["-lc", `ulimit -f 131072\n${command}`] };
}

export function terminalEnv() {
  const env = { ...process.env };
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") || "PATH";
  const localBin = join(homedir(), ".local", "bin");
  const paths = (env[key] || "").split(delimiter);
  if (!paths.includes(localBin)) paths.unshift(localBin);
  env[key] = paths.join(delimiter);
  return env;
}
