import { YouTubeAnalyticsApi } from "../analytics/query.js";
import { AuthManager, type FetchLike, type TokenPersistence } from "../auth/manager.js";
import { loadClientCredentials, readTokenFile, writeTokenFile, type StoredToken } from "../auth/store.js";
import { loadConfig, type AppConfig } from "../config.js";
import { GoogleClient } from "../google/client.js";
import { YouTubeDataApi } from "../google/youtubeData.js";
import type { ToolDeps } from "../tools.js";

export function persistenceFor(config: AppConfig, env: NodeJS.ProcessEnv): TokenPersistence {
  if (env.YT_MCP_REFRESH_TOKEN) {
    // Env-var mode (e.g. CI or cloud sessions): never write tokens to disk.
    let mem: StoredToken = { refresh_token: env.YT_MCP_REFRESH_TOKEN, scope: env.YT_MCP_SCOPES?.replace(/^["']|["']$/g, "") || undefined };
    return { load: () => mem, save: (t) => void (mem = t) };
  }
  return { load: () => readTokenFile(config.tokenFile), save: (t) => writeTokenFile(config.tokenFile, t) };
}

/** Wire the Google clients from configuration. `fetchImpl` lets tests stay offline. */
export function buildDeps(
  env: NodeJS.ProcessEnv = process.env,
  opts: { fetchImpl?: FetchLike; now?: () => Date } = {},
): { deps: ToolDeps; auth: AuthManager; config: AppConfig } {
  const config = loadConfig(env);
  const auth = new AuthManager(() => loadClientCredentials(config.clientSecretFile, env), persistenceFor(config, env), opts.fetchImpl);
  const client = new GoogleClient(auth, { fetchImpl: opts.fetchImpl });
  const deps: ToolDeps = {
    data: new YouTubeDataApi(client),
    analytics: new YouTubeAnalyticsApi(client),
    hasScope: (s) => auth.hasScope(s),
    today: opts.now ?? (() => new Date()),
  };
  return { deps, auth, config };
}
