import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * State for the remote connector's OAuth authorization server.
 *
 * Tokens are never stored in plain text: only SHA-256 hashes are kept, so a
 * leaked state file does not leak usable tokens. Authorization codes and
 * pending consent requests live in memory only (they expire in minutes).
 * Durable state (registered clients, access/refresh token hashes) can be
 * persisted to a JSON file (mode 600) so restarts don't force a reconnect.
 */

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export interface TokenRecord {
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number; // epoch ms
  /** Refresh-token family: all tokens descended from one sign-in. Revoked together on reuse. */
  family: string;
}

export interface RefreshRecord extends TokenRecord {
  /** Set when this refresh token has been exchanged (rotated). Reuse => theft => revoke family. */
  usedAt?: number;
}

export interface CodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

export interface PendingAuthorization {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

interface Persisted {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  access: Record<string, TokenRecord>;
  refresh: Record<string, RefreshRecord>;
}

const MAX_CLIENTS = 50;

export class OAuthStore {
  clients = new Map<string, OAuthClientInformationFull>();
  access = new Map<string, TokenRecord>();
  refresh = new Map<string, RefreshRecord>();
  codes = new Map<string, CodeRecord>();
  pending = new Map<string, PendingAuthorization>();

  constructor(
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {
    if (file && fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as Persisted;
      this.clients = new Map(Object.entries(data.clients ?? {}));
      this.access = new Map(Object.entries(data.access ?? {}));
      this.refresh = new Map(Object.entries(data.refresh ?? {}));
    }
  }

  addClient(c: OAuthClientInformationFull): void {
    this.clients.set(c.client_id, c);
    // Bound growth from repeated Dynamic Client Registration.
    while (this.clients.size > MAX_CLIENTS) {
      const oldest = [...this.clients.values()].sort((a, b) => (a.client_id_issued_at ?? 0) - (b.client_id_issued_at ?? 0))[0]!;
      this.clients.delete(oldest.client_id);
    }
    this.save();
  }

  revokeFamily(family: string): void {
    for (const [k, v] of this.access) if (v.family === family) this.access.delete(k);
    for (const [k, v] of this.refresh) if (v.family === family) this.refresh.delete(k);
    this.save();
  }

  /** Drop expired entries. Called opportunistically. */
  sweep(): void {
    const t = this.now();
    for (const m of [this.access, this.refresh, this.codes, this.pending] as Array<Map<string, { expiresAt: number }>>) {
      for (const [k, v] of m) if (v.expiresAt <= t) m.delete(k);
    }
  }

  save(): void {
    if (!this.file) return;
    this.sweep();
    const data: Persisted = {
      version: 1,
      clients: Object.fromEntries(this.clients),
      access: Object.fromEntries(this.access),
      refresh: Object.fromEntries(this.refresh),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
