#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolvePreset } from "./analytics/dates.js";
import { YouTubeAnalyticsApi } from "./analytics/query.js";
import { runLogin } from "./auth/login.js";
import { AuthManager, type TokenPersistence } from "./auth/manager.js";
import { deleteTokenFile, loadClientCredentials, readTokenFile, writeTokenFile, type StoredToken } from "./auth/store.js";
import { BASE_SCOPES, GOOGLE_REVOKE_URL, SCOPES, loadConfig, type AppConfig } from "./config.js";
import { YouTubeMcpError } from "./errors.js";
import { GoogleClient } from "./google/client.js";
import { YouTubeDataApi } from "./google/youtubeData.js";
import { log, redactString } from "./redact.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./server.js";
import type { ToolDeps } from "./tools.js";

const USAGE = `${SERVER_NAME} ${SERVER_VERSION} — read-only YouTube channel MCP server

Usage:
  youtube-channel-mcp [serve]          Start the MCP server on stdio (what Claude Code runs)
  youtube-channel-mcp auth [options]   Sign in with Google and save a token
      --monetary    Also request revenue/ad metrics access (YouTube Partner Program only)
      --manual      Headless sign-in: paste the redirected URL instead of using a local server
      --port <n>    Fixed loopback port for the redirect (default: random)
  youtube-channel-mcp status           Show configuration and sign-in status (no secrets)
  youtube-channel-mcp check            Live smoke test: read channel + one analytics query
  youtube-channel-mcp logout           Revoke the saved token and delete it

Environment:
  YT_MCP_CONFIG_DIR           Config directory (default ~/.config/youtube-channel-mcp)
  YT_MCP_CLIENT_SECRET_FILE   Path to the OAuth client JSON (default <config dir>/client_secret.json)
  YT_MCP_TOKEN_FILE           Path to the token file (default <config dir>/token.json)
  YT_MCP_CLIENT_ID / YT_MCP_CLIENT_SECRET / YT_MCP_REFRESH_TOKEN
                              Headless mode: supply credentials via env vars (token kept in memory only)
  YT_MCP_LOG_LEVEL            debug | info | warn | error (logs go to stderr, secrets redacted)
`;

function persistenceFor(config: AppConfig, env: NodeJS.ProcessEnv): TokenPersistence {
  if (env.YT_MCP_REFRESH_TOKEN) {
    // Env-var mode (e.g. CI or cloud sessions): never write tokens to disk.
    let mem: StoredToken = { refresh_token: env.YT_MCP_REFRESH_TOKEN, scope: env.YT_MCP_SCOPES };
    return { load: () => mem, save: (t) => void (mem = t) };
  }
  return { load: () => readTokenFile(config.tokenFile), save: (t) => writeTokenFile(config.tokenFile, t) };
}

export function buildDeps(env: NodeJS.ProcessEnv = process.env): { deps: ToolDeps; auth: AuthManager; config: AppConfig } {
  const config = loadConfig(env);
  const auth = new AuthManager(() => loadClientCredentials(config.clientSecretFile, env), persistenceFor(config, env));
  const client = new GoogleClient(auth);
  const deps: ToolDeps = {
    data: new YouTubeDataApi(client),
    analytics: new YouTubeAnalyticsApi(client),
    hasScope: (s) => auth.hasScope(s),
    today: () => new Date(),
  };
  return { deps, auth, config };
}

function parseFlags(args: string[]): { monetary: boolean; manual: boolean; port?: number } {
  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("--port must be 1-65535");
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
  console.error("1/2 Reading channel via YouTube Data API (channels.list mine=true)...");
  const ch = await deps.data.getMyChannel();
  console.error(`    OK: "${ch.snippet?.title}" (${ch.id}), ${ch.statistics?.videoCount ?? "?"} videos.`);
  console.error("2/2 Running a YouTube Analytics query (views, last 7 days)...");
  const range = resolvePreset("last_7_days", new Date());
  const rep = await deps.analytics.query({ ...range, metrics: ["views", "estimatedMinutesWatched"], dimensions: [] });
  if (rep.rows.length === 0) {
    console.error(`    OK: query succeeded but returned no rows for ${range.startDate}..${range.endDate} (no data yet).`);
  } else {
    console.error(`    OK: ${range.startDate}..${range.endDate}: views=${rep.rows[0]!.views}, minutesWatched=${rep.rows[0]!.estimatedMinutesWatched}`);
  }
  console.error("\nLive connection works.");
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
  if (e instanceof YouTubeMcpError) {
    console.error(`Error [${e.code}]: ${e.message}${e.hint ? `\nHint: ${e.hint}` : ""}`);
  } else {
    console.error(`Error: ${redactString((e as Error)?.message ?? String(e))}`);
  }
  process.exitCode = 1;
});
