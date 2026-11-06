#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runLogin } from "./auth/login.js";
import { deleteTokenFile, loadClientCredentials, readTokenFile, writeTokenFile } from "./auth/store.js";
import { runLiveCheck, LiveCheckError } from "./cli/check.js";
import { nodeRunner } from "./cli/claudeCode.js";
import { buildDeps } from "./cli/deps.js";
import { diagnoseFailure } from "./cli/diagnose.js";
import { formatDoctorReport, runDoctor } from "./cli/doctor.js";
import { CancelledError, HiddenInputUnavailableError, createTerminalPrompter } from "./cli/prompt.js";
import { runSetup } from "./cli/setup.js";
import { BASE_SCOPES, GOOGLE_REVOKE_URL, SCOPES, loadConfig } from "./config.js";
import { YouTubeMcpError } from "./errors.js";
import { log, redactString } from "./redact.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./server.js";
import { DashboardService } from "./dashboard/service.js";
import { ChannelGuard, createRemoteApp } from "./remote/app.js";
import { loadRemoteConfig } from "./remote/config.js";
import { OAuthStore } from "./remote/oauthStore.js";
import { OwnerOAuthProvider } from "./remote/provider.js";

const USAGE = `${SERVER_NAME} ${SERVER_VERSION} — read-only YouTube channel MCP server

Usage:
  youtube-channel-mcp setup [options]  Guided local setup: import OAuth client, sign in, check, register with Claude Code
      --manual      Headless sign-in (paste the redirected URL)
      --port <n>    Fixed loopback port for the sign-in redirect
  youtube-channel-mcp doctor [options] Diagnose "it doesn't connect" problems (no network unless --live)
      --live        Also make two read-only requests to Google
      --no-claude   Skip the Claude Code registration check
      --json        Machine-readable output
  youtube-channel-mcp [serve]          Start the MCP server on stdio (what Claude Code runs)
  youtube-channel-mcp auth [options]   Sign in with Google and save a token
      --monetary    Also request revenue/ad metrics access (YouTube Partner Program only)
      --manual      Headless sign-in: paste the redirected URL instead of using a local server
      --port <n>    Fixed loopback port for the redirect (default: random)
  youtube-channel-mcp status           Show configuration and sign-in status (no secrets)
  youtube-channel-mcp check            Live smoke test: read channel + one analytics query
  youtube-channel-mcp logout           Revoke the saved token and delete it
  youtube-channel-mcp serve-http       Start the authenticated REMOTE connector (for claude.ai artifacts); see docs/HOSTED_SETUP.md
  youtube-channel-mcp hash-password    Create YT_MCP_OWNER_PASSWORD_HASH for serve-http (hidden input;
                                       --stdin reads the passphrase from a pipe instead)
  youtube-channel-mcp env-export       Print YT_MCP_* variables for headless/cloud use (contains a SECRET)

Environment:
  YT_MCP_CONFIG_DIR           Config directory (default ~/.config/youtube-channel-mcp)
  YT_MCP_CLIENT_SECRET_FILE   Path to the OAuth client JSON (default <config dir>/client_secret.json)
  YT_MCP_TOKEN_FILE           Path to the token file (default <config dir>/token.json)
  YT_MCP_CLIENT_ID / YT_MCP_CLIENT_SECRET / YT_MCP_REFRESH_TOKEN
                              Headless mode: supply credentials via env vars (token kept in memory only)
  YT_MCP_LOG_LEVEL            debug | info | warn | error (logs go to stderr, secrets redacted)
`;

export function parseFlags(args: string[]): { monetary: boolean; manual: boolean; port?: number } {
  const portIdx = args.indexOf("--port");
  let port: number | undefined;
  if (portIdx >= 0) {
    const raw = args[portIdx + 1] ?? "";
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) throw new Error(`--port must be a whole number from 1 to 65535 (got "${raw}").`);
    port = Number(raw);
  }
  return { monetary: args.includes("--monetary"), manual: args.includes("--manual"), port };
}

async function cmdAuth(args: string[]) {
  const config = loadConfig();
  const creds = loadClientCredentials(config.clientSecretFile);
  const flags = parseFlags(args);
  const token = await runLogin(creds, flags);
  writeTokenFile(config.tokenFile, token);
  console.error(`\nSigned in. Token saved to ${config.tokenFile} (permissions 600).`);
  console.error("Next: run `youtube-channel-mcp check` to verify the connection.");
}

async function cmdStatus() {
  const config = loadConfig();
  const env = process.env;
  const out: Record<string, unknown> = {
    configDir: config.configDir,
    clientSecretFile: config.clientSecretFile,
    tokenFile: config.tokenFile,
  };
  try {
    const c = loadClientCredentials(config.clientSecretFile);
    out.oauthClient = { found: true, source: c.source, clientIdSuffix: `…${c.clientId.slice(-24)}` };
  } catch (e) {
    out.oauthClient = { found: false, problem: (e as Error).message };
  }
  const t = env.YT_MCP_REFRESH_TOKEN ? { refresh_token: "env", scope: env.YT_MCP_SCOPES } : readTokenFile(config.tokenFile);
  out.token = t
    ? {
        source: env.YT_MCP_REFRESH_TOKEN ? "YT_MCP_REFRESH_TOKEN env var" : config.tokenFile,
        hasRefreshToken: Boolean(t.refresh_token),
        accessTokenExpiresAt: "expiry_date" in t && t.expiry_date ? new Date(t.expiry_date).toISOString() : null,
        grantedScopes: (t.scope ?? "(unknown until first refresh)").split(" "),
        missingBaseScopes: t.scope ? BASE_SCOPES.filter((s) => !t.scope!.split(" ").includes(s)) : [],
        monetary: t.scope ? t.scope.includes(SCOPES.analyticsMonetaryReadonly) : null,
      }
    : { signedIn: false, hint: "Run `youtube-channel-mcp auth`." };
  console.log(JSON.stringify(out, null, 2));
}

async function cmdCheck() {
  const { deps } = buildDeps();
  try {
    await runLiveCheck(deps, (l) => console.error(l));
  } catch (e) {
    const d = diagnoseFailure(e instanceof LiveCheckError ? e.error : e, e instanceof LiveCheckError ? e.step : undefined);
    console.error(`\nProblem: ${d.title}. ${d.detail}\nNext: ${d.next}`);
    process.exitCode = 1;
    return;
  }
  console.error("\nLive connection works.");
}

async function cmdSetup(args: string[]) {
  const flags = parseFlags(args);
  const r = await runSetup({ prompter: createTerminalPrompter(), runner: nodeRunner, loginFlags: { manual: flags.manual, port: flags.port } });
  process.exitCode = r.exitCode;
}

async function cmdDoctor(args: string[]) {
  const report = await runDoctor({ live: args.includes("--live"), checkClaude: !args.includes("--no-claude"), runner: nodeRunner });
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(formatDoctorReport(report));
  process.exitCode = report.exitCode;
}

async function cmdLogout() {
  const config = loadConfig();
  const t = readTokenFile(config.tokenFile);
  const tok = t?.refresh_token ?? t?.access_token;
  if (tok) {
    try {
      const res = await fetch(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tok }),
      });
      console.error(res.ok ? "Revoked access at Google." : `Google revoke returned HTTP ${res.status} (token may already be invalid).`);
    } catch (e) {
      console.error(`Could not reach Google to revoke: ${(e as Error).message}`);
    }
  }
  console.error(deleteTokenFile(config.tokenFile) ? `Deleted ${config.tokenFile}.` : "No saved token found.");
  console.error("You can also remove access at https://myaccount.google.com/permissions");
}

async function cmdEnvExport() {
  const config = loadConfig();
  const creds = loadClientCredentials(config.clientSecretFile);
  const t = readTokenFile(config.tokenFile);
  if (!t?.refresh_token) {
    console.error("No saved refresh token. Run `youtube-channel-mcp auth` first.");
    process.exitCode = 1;
    return;
  }
  console.error(
    "WARNING: the values below are secrets that grant read access to your YouTube channel and analytics.\n" +
      "Paste them only into a secret store (e.g. your cloud environment's environment variables). Never commit them,\n" +
      "never paste them into a chat, and revoke access at https://myaccount.google.com/permissions if they leak.\n",
  );
  // Written to stdout deliberately so it can be redirected; this is the only command that prints secrets.
  process.stdout.write(`YT_MCP_CLIENT_ID=${creds.clientId}\n`);
  if (creds.clientSecret) process.stdout.write(`YT_MCP_CLIENT_SECRET=${creds.clientSecret}\n`);
  process.stdout.write(`YT_MCP_REFRESH_TOKEN=${t.refresh_token}\n`);
  if (t.scope) process.stdout.write(`YT_MCP_SCOPES="${t.scope}"\n`);
}

async function cmdServeHttp() {
  const cfg = loadRemoteConfig();
  const { deps, auth } = buildDeps();
  if (!auth.isSignedIn()) throw new Error("No Google credentials. Provide YT_MCP_CLIENT_ID/YT_MCP_CLIENT_SECRET/YT_MCP_REFRESH_TOKEN or a token file.");
  const store = new OAuthStore(cfg.stateFile);
  const provider = new OwnerOAuthProvider({
    resource: cfg.resourceUrl,
    ownerPasswordHash: cfg.ownerPasswordHash,
    store,
    extraRedirectUris: cfg.extraRedirectUris,
  });
  const guard = new ChannelGuard(deps, cfg.expectedChannelId);
  await guard.check(); // fail fast if the Google token is for another channel
  const app = createRemoteApp({
    publicUrl: cfg.publicUrl,
    resourceUrl: cfg.resourceUrl,
    provider,
    deps,
    dashboard: new DashboardService(deps, { ttlMs: cfg.dashboardTtlMs }),
    guard: guard.check,
    allowedHosts: cfg.allowedHosts,
    trustProxy: cfg.trustProxy,
  });
  app.listen(cfg.port, cfg.host, () => {
    log.info(`Remote connector listening on ${cfg.host}:${cfg.port}; public MCP URL ${cfg.resourceUrl.href} (OAuth required, channel ${cfg.expectedChannelId}).`);
  });
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function cmdHashPassword(args: string[]) {
  let pw: string;
  if (args.includes("--stdin")) {
    if (process.stdin.isTTY) throw new Error("--stdin expects the passphrase to be piped in. In a terminal, run `youtube-channel-mcp hash-password` without --stdin for hidden input.");
    pw = await readAllStdin();
  } else {
    const p = createTerminalPrompter();
    try {
      pw = await p.secret("Owner passphrase (min 12 characters, not shown): ");
      const again = await p.secret("Repeat the passphrase: ");
      if (again !== pw) throw new Error("The passphrases didn't match. Nothing was created.");
    } catch (e) {
      if (e instanceof HiddenInputUnavailableError) {
        throw new Error(`${e.message} Run this in an interactive terminal, or pipe the passphrase explicitly: \`... | youtube-channel-mcp hash-password --stdin\`.`);
      }
      throw e;
    } finally {
      p.close();
    }
  }
  const { hashPassword } = await import("./remote/password.js");
  process.stdout.write(`${hashPassword(pw.trim())}\n`); // trimmed, as in earlier versions
}

async function cmdServe() {
  const { deps, auth } = buildDeps();
  if (!auth.isSignedIn()) {
    log.warn("Not signed in yet. Tools will return AUTH_REQUIRED until you run `youtube-channel-mcp auth`.");
  }
  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
  log.info(`${SERVER_NAME} ${SERVER_VERSION} running on stdio (read-only).`);
}

async function main() {
  const [cmd = "serve", ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "serve":
      return cmdServe();
    case "auth":
      return cmdAuth(rest);
    case "status":
      return cmdStatus();
    case "check":
      return cmdCheck();
    case "logout":
      return cmdLogout();
    case "serve-http":
      return cmdServeHttp();
    case "hash-password":
      return cmdHashPassword(rest);
    case "setup":
      return cmdSetup(rest);
    case "doctor":
      return cmdDoctor(rest);
    case "env-export":
      return cmdEnvExport();
    case "help":
    case "--help":
    case "-h":
      console.error(USAGE);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  if (e instanceof CancelledError) {
    console.error("\nCancelled.");
    process.exitCode = 130;
    return;
  }
  if (e instanceof YouTubeMcpError) {
    console.error(`Error [${e.code}]: ${e.message}${e.hint ? `\nHint: ${e.hint}` : ""}`);
  } else {
    console.error(`Error: ${redactString((e as Error)?.message ?? String(e))}`);
  }
  process.exitCode = 1;
});
