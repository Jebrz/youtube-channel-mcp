import fs from "node:fs";
import type { FetchLike } from "../auth/manager.js";
import { findEnclosingGitRepo, inspectClientSecretJson, maskClientId, type StoredToken } from "../auth/store.js";
import { BASE_SCOPES, SCOPES, loadConfig } from "../config.js";
import { ChannelMismatchError } from "../remote/app.js";
import { loadRemoteConfig } from "../remote/config.js";
import { LiveCheckError, runLiveCheck } from "./check.js";
import { REGISTRATION_NAME, findClaude, getRegistration, registrationCommandLines, serverLaunchCommand, type CommandRunner, type LaunchCommand } from "./claudeCode.js";
import { buildDeps } from "./deps.js";
import { diagnoseFailure, type CheckResult } from "./diagnose.js";

export type { CheckResult } from "./diagnose.js";

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  /** Make real (read-only) Google requests. Off by default. */
  live?: boolean;
  /** Check Claude Code registration (runs `claude --version` and `claude mcp get`). */
  checkClaude?: boolean;
  runner?: CommandRunner;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  fetchImpl?: FetchLike;
  launch?: LaunchCommand;
  now?: () => Date;
}

export interface DoctorReport {
  results: CheckResult[];
  /** 1 when any check needs action, else 0. */
  exitCode: number;
}

const TESTING_MODE_DAYS = 7;

export function checkNodeVersion(version: string): CheckResult {
  const m = /^v?(\d+)\.(\d+)/.exec(version);
  const major = m ? Number(m[1]) : 0;
  const minor = m ? Number(m[2]) : 0;
  const base = { id: "node", title: "Node.js version" };
  if (major < 20) return { ...base, status: "action", detail: `Node.js ${version} is too old.`, next: "Install the current Node.js LTS from https://nodejs.org (22 or newer), then reopen the terminal." };
  if (major === 20 || (major === 22 && minor < 12) || major === 21) {
    return { ...base, status: "warn", detail: `Node.js ${version} works for the server, but Node 20 reached end of life on 2026-04-30 and the test tools need 22.12+.`, next: "Upgrade to the current Node.js LTS from https://nodejs.org when you can." };
  }
  return { ...base, status: "ok", detail: `Node.js ${version}.` };
}

function modeIsLoose(file: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return false; // Windows uses ACLs on the user profile folder
  try {
    return (fs.statSync(file).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

function readTokenSafely(file: string): { token?: StoredToken; problem?: string } {
  if (!fs.existsSync(file)) return {};
  try {
    const t = JSON.parse(fs.readFileSync(file, "utf8")) as StoredToken;
    if (!t || typeof t !== "object") return { problem: "The token file is not a JSON object." };
    return { token: t };
  } catch {
    return { problem: "The token file is not valid JSON." };
  }
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? (() => new Date());
  const results: CheckResult[] = [];
  const add = (r: CheckResult) => results.push(r);

  // 1. Runtime
  add(checkNodeVersion(opts.nodeVersion ?? process.version));

  // 2. Configuration location
  const config = loadConfig(env);
  const overrides = Object.keys(env).filter((k) => k.startsWith("YT_MCP_")).sort();
  const repo = findEnclosingGitRepo(config.configDir);
  add({
    id: "config-dir",
    title: "Configuration folder",
    status: repo ? "warn" : "ok",
    detail: `${config.configDir}${fs.existsSync(config.configDir) ? "" : " (not created yet)"}${overrides.length ? `. Settings from environment variables: ${overrides.join(", ")}` : ""}.`,
    next: repo ? `This folder is inside a git repository (${repo}). Set YT_MCP_CONFIG_DIR to a folder outside any repository so credentials can't be committed.` : undefined,
  });

  // 3. OAuth client
  let clientOk = false;
  if (env.YT_MCP_CLIENT_ID) {
    clientOk = true;
    add({ id: "oauth-client", title: "OAuth client", status: "ok", detail: `From environment variable YT_MCP_CLIENT_ID (${maskClientId(env.YT_MCP_CLIENT_ID)}).` });
  } else if (!fs.existsSync(config.clientSecretFile)) {
    add({
      id: "oauth-client",
      title: "OAuth client",
      status: "action",
      detail: `No OAuth client file at ${config.clientSecretFile}.`,
      next: "Run `youtube-channel-mcp setup` and give it the 'Desktop app' OAuth client JSON you downloaded from Google Cloud Console.",
    });
  } else {
    const info = inspectClientSecretJson(fs.readFileSync(config.clientSecretFile, "utf8"));
    if (!info.ok) {
      add({ id: "oauth-client", title: "OAuth client", status: "action", detail: `${config.clientSecretFile}: ${info.problem}`, next: info.hint ?? "Run `youtube-channel-mcp setup` to import a valid Desktop app client JSON." });
    } else {
      clientOk = true;
      const loose = modeIsLoose(config.clientSecretFile, platform);
      add({
        id: "oauth-client",
        title: "OAuth client",
        status: info.warning || loose ? "warn" : "ok",
        detail: `Desktop app client ${maskClientId(info.clientId!)} at ${config.clientSecretFile}.${info.warning ? ` ${info.warning}` : ""}`,
        next: loose ? `Other users on this computer can read the file. Run: chmod 600 "${config.clientSecretFile}"` : undefined,
      });
    }
  }

  // 4. Sign-in
  let signedIn = false;
  if (env.YT_MCP_REFRESH_TOKEN) {
    signedIn = true;
    add({ id: "sign-in", title: "Google sign-in", status: "ok", detail: "Refresh token supplied by the YT_MCP_REFRESH_TOKEN environment variable (kept in memory only). Its permissions can only be confirmed with `doctor --live`." });
  } else {
    const { token, problem } = readTokenSafely(config.tokenFile);
    if (problem) {
      add({ id: "sign-in", title: "Google sign-in", status: "action", detail: `${config.tokenFile}: ${problem}`, next: "Run `youtube-channel-mcp auth` to sign in again (it replaces the file)." });
    } else if (!token) {
      add({ id: "sign-in", title: "Google sign-in", status: "action", detail: "You haven't signed in yet (no saved token).", next: "Run `youtube-channel-mcp setup` (or `youtube-channel-mcp auth`)." });
    } else if (!token.refresh_token) {
      add({ id: "sign-in", title: "Google sign-in", status: "action", detail: "The saved sign-in has no refresh token, so it stops working within an hour.", next: "Run `youtube-channel-mcp auth` again." });
    } else {
      signedIn = true;
      const granted = (token.scope ?? "").split(/\s+/).filter(Boolean);
      const missing = granted.length ? BASE_SCOPES.filter((s) => !granted.includes(s)) : [];
      const names = granted.map((s) => s.replace("https://www.googleapis.com/auth/", "")).join(", ") || "not recorded";
      let ageNote = "";
      let ageWarn = false;
      if (token.obtained_at) {
        const days = Math.floor((now().getTime() - Date.parse(token.obtained_at)) / 86_400_000);
        ageNote = ` Signed in ${days} day(s) ago.`;
        ageWarn = days >= TESTING_MODE_DAYS;
      }
      add({
        id: "sign-in",
        title: "Google sign-in",
        status: missing.length ? "action" : ageWarn ? "warn" : "ok",
        detail: `Saved at ${config.tokenFile}. Permissions recorded: ${names}.${granted.includes(SCOPES.analyticsMonetaryReadonly) ? " (Includes revenue access.)" : ""}${ageNote}`,
        next: missing.length
          ? `Missing: ${missing.map((s) => s.replace("https://www.googleapis.com/auth/", "")).join(", ")}. Run \`youtube-channel-mcp auth\` and tick every checkbox on the consent screen.`
          : ageWarn
            ? "If your OAuth consent screen is in Testing status, this sign-in has expired (Google limits Testing sign-ins to 7 days). `doctor --live` will confirm."
            : "This tool can't see your consent screen's publishing status. If it's 'Testing', you'll need to sign in again every 7 days.",
      });
      if (modeIsLoose(config.tokenFile, platform)) {
        add({ id: "token-permissions", title: "Token file permissions", status: "warn", detail: "Other users on this computer can read the token file.", next: `Run: chmod 600 "${config.tokenFile}"` });
      }
    }
  }

  // 5. Hosted connector configuration (only when configured)
  if (env.YT_MCP_PUBLIC_URL || env.YT_MCP_OWNER_PASSWORD_HASH || env.YT_MCP_EXPECTED_CHANNEL_ID) {
    try {
      const rc = loadRemoteConfig(env);
      add({ id: "remote-config", title: "Hosted connector settings", status: "ok", detail: `MCP URL ${rc.resourceUrl.href}, port ${rc.port}, serves only channel ${rc.expectedChannelId}.` });
    } catch (e) {
      const d = diagnoseFailure(e);
      add({ id: "remote-config", title: "Hosted connector settings", status: "action", detail: d.detail, next: d.next });
    }
  }

  // 6. Claude Code registration
  if (opts.checkClaude !== false && opts.runner) {
    const launch = opts.launch ?? serverLaunchCommand(undefined, env);
    const cmds = registrationCommandLines(launch);
    const claude = await findClaude(opts.runner);
    if (!claude.available) {
      add({
        id: "claude-code",
        title: "Claude Code registration",
        status: "warn",
        detail: `Claude Code wasn't found (${claude.problem}). The connector itself can still work.`,
        next: `Install Claude Code, then register the server:\n      PowerShell:    ${cmds.powershell}\n      macOS/Linux:   ${cmds.posix}`,
      });
    } else {
      const reg = await getRegistration(opts.runner);
      if ("unknown" in reg) {
        add({ id: "claude-code", title: "Claude Code registration", status: "warn", detail: `Couldn't read the registration: ${reg.problem}`, next: `Check with: claude mcp get ${REGISTRATION_NAME}` });
      } else if (!reg.exists) {
        add({
          id: "claude-code",
          title: "Claude Code registration",
          status: "action",
          detail: `Claude Code ${claude.version ?? ""} has no MCP server named "${REGISTRATION_NAME}".`.replace("  ", " "),
          next: `Register it:\n      PowerShell:    ${cmds.powershell}\n      macOS/Linux:   ${cmds.posix}\n    (Or run \`youtube-channel-mcp setup\`, which asks before registering.)`,
        });
      } else if (reg.entryFile && reg.entryFileExists === false) {
        add({
          id: "claude-code",
          title: "Claude Code registration",
          status: "action",
          detail: `"${REGISTRATION_NAME}" points to ${reg.entryFile}, which doesn't exist (moved or deleted folder?).`,
          next: `Re-register: claude mcp remove ${REGISTRATION_NAME}   then   ${platform === "win32" ? cmds.powershell : cmds.posix}`,
        });
      } else {
        const failed = /fail|×/i.test(reg.status ?? "");
        add({
          id: "claude-code",
          title: "Claude Code registration",
          status: failed ? "warn" : "ok",
          detail: `"${REGISTRATION_NAME}" is registered${reg.scope ? ` (${reg.scope})` : ""}. Command: ${reg.command ?? "?"} ${reg.args ?? ""}${reg.status ? `. Status: ${reg.status}` : ""}.`,
          next: failed ? "Claude Code couldn't start it. Run `youtube-channel-mcp serve` in a terminal to see the error, and fix the actions above first." : undefined,
        });
      }
    }
  }

  // 7. Optional live check (explicit only)
  if (opts.live) {
    if (!clientOk || !signedIn) {
      add({ id: "live", title: "Live Google check", status: "action", detail: "Skipped: fix the OAuth client and sign-in first.", next: "Follow the actions above, then run `youtube-channel-mcp doctor --live` again." });
    } else {
      try {
        const { deps } = buildDeps(env, { fetchImpl: opts.fetchImpl, now });
        const r = await runLiveCheck(deps);
        const expected = env.YT_MCP_EXPECTED_CHANNEL_ID;
        if (expected && expected !== r.channelId) throw new LiveCheckError("channel", new ChannelMismatchError());
        add({
          id: "live",
          title: "Live Google check",
          status: "ok",
          detail: `Signed in as channel "${r.channelTitle ?? "(untitled)"}" (${r.channelId}). Analytics query for ${r.range.startDate}..${r.range.endDate} ${r.analytics ? "returned data" : "succeeded but returned no rows (no data yet)"}.`,
        });
      } catch (e) {
        const step = e instanceof LiveCheckError ? e.step : undefined;
        const d = diagnoseFailure(e instanceof LiveCheckError ? e.error : e, step);
        add({ id: "live", title: `Live Google check: ${d.title}`, status: "action", detail: d.detail, next: d.next });
      }
    }
  } else {
    add({ id: "live", title: "Live Google check", status: "warn", detail: "Not run (no network requests were made).", next: "Run `youtube-channel-mcp doctor --live` to make two read-only requests to Google and confirm everything works." });
  }

  return { results, exitCode: results.some((r) => r.status === "action") ? 1 : 0 };
}

const LABEL = { ok: "OK    ", warn: "WARN  ", action: "ACTION" } as const;

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["youtube-channel-mcp doctor", ""];
  for (const r of report.results) {
    lines.push(`[${LABEL[r.status]}] ${r.title}: ${r.detail}`);
    if (r.next) lines.push(`         Next: ${r.next}`);
  }
  const counts = { ok: 0, warn: 0, action: 0 };
  report.results.forEach((r) => counts[r.status]++);
  lines.push("", `${counts.ok} OK, ${counts.warn} warning(s), ${counts.action} action(s) required.`);
  if (counts.action) lines.push("Fix the ACTION items from top to bottom; later checks often depend on earlier ones.");
  return lines.join("\n");
}

