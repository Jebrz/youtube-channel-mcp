import express, { type Request, type Response } from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { DashboardService } from "../dashboard/service.js";
import { YouTubeMcpError } from "../errors.js";
import { log } from "../redact.js";
import { createServer } from "../server.js";
import type { ToolDeps } from "../tools.js";
import { MCP_SCOPE, sendConsentPage, setPageSecurityHeaders, type OwnerOAuthProvider } from "./provider.js";

export class ChannelMismatchError extends YouTubeMcpError {
  constructor() {
    super("CHANNEL_MISMATCH", "The Google account configured on this server is not the channel this deployment is allowed to serve. No data was returned.", {
      hint: "Re-authorize the server with the correct channel, or fix YT_MCP_EXPECTED_CHANNEL_ID.",
    });
  }
}

/**
 * Account isolation: before serving any tool, confirm the Google token on this
 * server still belongs to the configured channel. Result is cached briefly
 * (1 Data API unit per check).
 */
export class ChannelGuard {
  private verifiedAt = 0;
  constructor(
    private readonly deps: ToolDeps,
    private readonly expectedChannelId: string,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  readonly check = async (): Promise<void> => {
    if (this.now() - this.verifiedAt < this.ttlMs) return;
    const ch = await this.deps.data.getMyChannel();
    if (ch.id !== this.expectedChannelId) {
      this.verifiedAt = 0;
      log.error("Channel isolation check failed: Google token belongs to a different channel.");
      throw new ChannelMismatchError();
    }
    this.verifiedAt = this.now();
  };
}

export interface RemoteAppOptions {
  publicUrl: URL;
  resourceUrl: URL;
  provider: OwnerOAuthProvider;
  deps: ToolDeps;
  dashboard: DashboardService;
  guard: () => Promise<void>;
  allowedHosts: string[];
  trustProxy?: boolean | number;
  /** Disable express-rate-limit on OAuth endpoints (tests only). */
  disableRateLimits?: boolean;
}

export function createRemoteApp(o: RemoteAppOptions): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", o.trustProxy ?? false);

  // Liveness only (registered before the Host check so platform probes that use an
  // internal host name still work): no channel, credential, cache or analytics information.
  // `/health` is the documented path. Cloud Run reserves some paths ending in
  // "z", so `/healthz` is kept only as a compatibility alias and may not reach
  // the container there.
  app.get(["/health", "/healthz"], (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  });

  // DNS-rebinding / host-header protection.
  app.use((req, res, next) => {
    const host = req.headers.host ?? "";
    if (!o.allowedHosts.includes(host)) {
      res.status(421).json({ error: "misdirected_request" });
      return;
    }
    next();
  });

  const rl = o.disableRateLimits ? { rateLimit: false as const } : {};
  app.use(
    mcpAuthRouter({
      provider: o.provider,
      issuerUrl: o.publicUrl,
      resourceServerUrl: o.resourceUrl,
      scopesSupported: [MCP_SCOPE],
      resourceName: "YouTube Channel (read-only)",
      authorizationOptions: rl,
      tokenOptions: rl,
      clientRegistrationOptions: { ...rl, clientSecretExpirySeconds: 0 },
      revocationOptions: rl,
    }),
  );

  // Owner passphrase form target.
  app.post("/oauth/approve", express.urlencoded({ extended: false, limit: "8kb" }), (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const pendingId = String(body.pending ?? "");
    const decision = body.decision === "deny" ? "deny" : "approve";
    const r = o.provider.approve(pendingId, String(body.password ?? ""), decision, req.ip ?? "unknown");
    if (r.kind === "redirect") {
      res.setHeader("Cache-Control", "no-store");
      res.redirect(302, r.location);
    } else if (r.kind === "retry") {
      const p = o.provider.getPending(r.pendingId);
      sendConsentPage(res, r.pendingId, p?.clientName, p?.redirectUri ?? "https://claude.ai", r.message, 401);
    } else {
      setPageSecurityHeaders(res);
      res.status(r.status).type("text/plain").send(r.message);
    }
  });

  const bearer = requireBearerAuth({
    verifier: o.provider,
    requiredScopes: [MCP_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(o.resourceUrl),
    expectedResource: o.resourceUrl,
  });

  app.all("/mcp", bearer, express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
    if (req.method !== "POST") {
      res.status(405).setHeader("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
      return;
    }
    // Stateless Streamable HTTP: a fresh MCP server per request; caches live in shared deps.
    const server = createServer(o.deps, { dashboard: o.dashboard, guard: o.guard });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log.error("MCP request failed", e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  return app;
}
