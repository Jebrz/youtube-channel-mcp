import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatCommand } from "./paths.js";

/**
 * Talking to the Claude Code CLI (`claude mcp ...`) to register this server.
 * We only ever run `claude --version`, `claude mcp get <name>`,
 * `claude mcp add ...` and `claude mcp remove <name>`, and we never print the
 * registration's environment section (it may hold other people's secrets).
 */

export const REGISTRATION_NAME = "youtube-channel";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** "not_found" when the program doesn't exist, "timeout" when it took too long. */
  error?: "not_found" | "timeout" | "spawn_failed";
}

export interface CommandRunner {
  run(command: string, args: string[], opts?: { timeoutMs?: number }): Promise<RunResult>;
}

/** cmd.exe needs .cmd shims run through a shell; quote each argument for it. */
function quoteForCmd(arg: string): string {
  if (/["%^\r\n]/.test(arg)) throw new Error(`Refusing to pass an argument with special characters to cmd.exe: ${arg}`);
  return /[\s&|<>()]/.test(arg) ? `"${arg}"` : arg;
}

export const nodeRunner: CommandRunner = {
  run(command, args, opts = {}) {
    return new Promise((resolve) => {
      const win = process.platform === "win32";
      let child;
      try {
        child = win
          ? spawn([command, ...args].map(quoteForCmd).join(" "), { shell: true, windowsHide: true })
          : spawn(command, args, { windowsHide: true });
      } catch {
        return resolve({ code: null, stdout: "", stderr: "", error: "spawn_failed" });
      }
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        resolve({ code: null, stdout, stderr, error: "timeout" });
      }, opts.timeoutMs ?? 60_000);
      child.stdout?.on("data", (d) => (stdout += d));
      child.stderr?.on("data", (d) => (stderr += d));
      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr, error: e.code === "ENOENT" ? "not_found" : "spawn_failed" });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        // cmd.exe reports a missing program as exit code 9009 / "is not recognized".
        if (win && (code === 9009 || /is not recognized as an internal or external command/i.test(stderr))) {
          return resolve({ code, stdout, stderr, error: "not_found" });
        }
        if (!win && code === 127) return resolve({ code, stdout, stderr, error: "not_found" });
        resolve({ code, stdout, stderr });
      });
    });
  },
};

export interface LaunchCommand {
  command: string;
  args: string[];
  /** Non-secret environment variables Claude Code must pass to the server (paths only). */
  env?: Record<string, string>;
}

/** Path settings that must follow the server into Claude Code. Secrets are never included. */
export const PASS_THROUGH_ENV = ["YT_MCP_CONFIG_DIR", "YT_MCP_CLIENT_SECRET_FILE", "YT_MCP_TOKEN_FILE"] as const;

export function passThroughEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PASS_THROUGH_ENV) if (env[k]) out[k] = env[k]!;
  return out;
}

/** How Claude Code should start this server: `node <absolute path to dist/index.js> serve`. */
export function serverLaunchCommand(entryFile?: string, env: NodeJS.ProcessEnv = process.env): LaunchCommand {
  const file = entryFile ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js");
  const pass = passThroughEnv(env);
  return { command: "node", args: [file, "serve"], ...(Object.keys(pass).length ? { env: pass } : {}) };
}

export function registrationArgs(launch: LaunchCommand, name = REGISTRATION_NAME, scope: "user" | "local" | "project" = "user"): string[] {
  const envArgs = Object.entries(launch.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return ["mcp", "add", name, "--scope", scope, ...envArgs, "--", launch.command, ...launch.args];
}

/** Copyable registration commands for both shells. */
export function registrationCommandLines(launch: LaunchCommand, name = REGISTRATION_NAME): { powershell: string; posix: string } {
  const args = registrationArgs(launch, name);
  return { powershell: formatCommand("claude", args, "powershell"), posix: formatCommand("claude", args, "posix") };
}

export async function findClaude(runner: CommandRunner): Promise<{ available: boolean; version?: string; problem?: string }> {
  const r = await runner.run("claude", ["--version"], { timeoutMs: 20_000 });
  if (r.error === "not_found") return { available: false, problem: "The `claude` command was not found on PATH." };
  if (r.error || r.code !== 0) return { available: false, problem: `\`claude --version\` failed${r.error ? ` (${r.error})` : ` (exit ${r.code})`}.` };
  return { available: true, version: r.stdout.trim().split(/\r?\n/)[0] };
}

export interface Registration {
  exists: boolean;
  scope?: string;
  status?: string;
  command?: string;
  args?: string;
  /** Path to a JavaScript entry file found in the registration, if any. */
  entryFile?: string;
  entryFileExists?: boolean;
}

/** Parse `claude mcp get <name>` output, keeping only the fields we need (never Environment). */
export function parseRegistration(stdout: string): Registration {
  const field = (label: string) => {
    const m = new RegExp(`^\\s*${label}:\\s*(.*)$`, "mi").exec(stdout);
    return m ? m[1]!.trim() : undefined;
  };
  const args = field("Args");
  const command = field("Command");
  const jsMatch = /(.*?\.(?:js|mjs|cjs))(?:\s+serve)?\s*$/i.exec(args ?? "");
  const entryFile = jsMatch ? jsMatch[1]!.trim() : undefined;
  return {
    exists: true,
    scope: field("Scope"),
    status: field("Status"),
    command,
    args,
    entryFile,
    entryFileExists: entryFile ? fs.existsSync(entryFile) : undefined,
  };
}

export async function getRegistration(runner: CommandRunner, name = REGISTRATION_NAME): Promise<Registration | { unknown: true; problem: string }> {
  const r = await runner.run("claude", ["mcp", "get", name], { timeoutMs: 90_000 });
  if (r.error) return { unknown: true, problem: `\`claude mcp get\` could not run (${r.error}).` };
  if (r.code !== 0) {
    if (/No MCP server named/i.test(r.stdout + r.stderr)) return { exists: false };
    return { unknown: true, problem: `\`claude mcp get ${name}\` exited with code ${r.code}.` };
  }
  return parseRegistration(r.stdout);
}

export async function addRegistration(runner: CommandRunner, launch: LaunchCommand, name = REGISTRATION_NAME): Promise<RunResult> {
  return runner.run("claude", registrationArgs(launch, name), { timeoutMs: 60_000 });
}

export async function removeRegistration(runner: CommandRunner, name = REGISTRATION_NAME): Promise<RunResult> {
  return runner.run("claude", ["mcp", "remove", name], { timeoutMs: 60_000 });
}
