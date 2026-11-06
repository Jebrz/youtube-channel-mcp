import os from "node:os";
import path from "node:path";

export interface PathContext {
  platform?: NodeJS.Platform;
  homedir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Turn whatever a beginner pastes or drags into the terminal into a usable
 * absolute path:
 *   - surrounding quotes:          "C:\Users\Me\My Downloads\client.json"
 *   - PowerShell drag-and-drop:    & 'C:\Users\Me\My Downloads\client.json'
 *   - macOS/Linux escaped spaces:  /Users/me/My\ Downloads/client.json
 *   - home shortcuts:              ~/Downloads/x.json, %USERPROFILE%\Downloads\x.json
 * Returns undefined for empty input.
 */
export function normalizeUserPath(raw: string, ctx: PathContext = {}): string | undefined {
  const platform = ctx.platform ?? process.platform;
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  const home = ctx.homedir ?? os.homedir();
  const env = ctx.env ?? process.env;
  const cwd = ctx.cwd ?? process.cwd();

  let s = raw.trim();
  if (!s) return undefined;
  if (s.startsWith("& ")) s = s.slice(2).trim(); // PowerShell call operator from drag-and-drop
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1);
    if (s.startsWith("'") || s.startsWith('"')) s = s.slice(1, -1); // doubly quoted
  }
  s = s.trim();
  if (!s) return undefined;
  if (!win) s = s.replace(/\\(.)/g, "$1"); // shell-escaped characters like "\ "
  if (s === "~") s = home;
  else if (s.startsWith("~/") || (win && s.startsWith("~\\"))) s = p.join(home, s.slice(2));
  if (win) s = s.replace(/%([A-Za-z0-9_]+)%/g, (m, name: string) => env[name] ?? env[name.toUpperCase()] ?? m);
  return p.resolve(cwd, s);
}

/** Quote one argument for display in the given shell, so a beginner can copy the command. */
export function quoteArg(arg: string, shell: "powershell" | "posix"): string {
  if (/^[A-Za-z0-9_\-./:=@\\]+$/.test(arg)) return arg;
  if (shell === "powershell") return `'${arg.replace(/'/g, "''")}'`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function formatCommand(command: string, args: string[], shell: "powershell" | "posix"): string {
  return [command, ...args].map((a) => quoteArg(a, shell)).join(" ");
}
