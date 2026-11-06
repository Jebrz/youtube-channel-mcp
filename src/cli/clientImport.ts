import fs from "node:fs";
import path from "node:path";
import { findEnclosingGitRepo, inspectClientSecretJson, maskClientId } from "../auth/store.js";
import { ConfigError } from "../errors.js";

/** OAuth client JSON files from Google are ~500 bytes; refuse anything absurdly large. */
const MAX_CLIENT_FILE_BYTES = 64 * 1024;

export type ImportStatus = "imported" | "replaced" | "kept-existing" | "already-installed";

export interface ImportResult {
  status: ImportStatus;
  dest: string;
  clientIdMasked: string;
  /** Path of the backup made before replacing an existing client file. */
  backup?: string;
  warnings: string[];
}

export interface ImportOptions {
  sourcePath: string;
  destPath: string;
  /** Called only when a different client file already exists at destPath. */
  confirmOverwrite: (info: { existingClientId?: string; newClientId: string }) => Promise<boolean>;
  now?: () => Date;
}

/**
 * Validate a downloaded OAuth client JSON and copy it into the config
 * directory (outside the repository) with owner-only permissions.
 * Nothing secret is returned or printed.
 */
export async function importClientSecret(opts: ImportOptions): Promise<ImportResult> {
  const src = path.resolve(opts.sourcePath);
  const dest = path.resolve(opts.destPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(src);
  } catch {
    throw new ConfigError(`No file found at ${src}.`, "Check the path. Tip: drag the file into this window, or copy its full path (on Windows: Shift + right-click > Copy as path).");
  }
  if (stat.isDirectory()) throw new ConfigError(`${src} is a folder, not a file.`, "Enter the path of the downloaded .json file itself.");
  if (stat.size > MAX_CLIENT_FILE_BYTES) throw new ConfigError(`${src} is too large to be an OAuth client JSON file.`);

  const text = fs.readFileSync(src, "utf8");
  const info = inspectClientSecretJson(text);
  if (!info.ok) throw new ConfigError(`${path.basename(src)}: ${info.problem}`, info.hint);
  const warnings = info.warning ? [info.warning] : [];
  if (!info.hasClientSecret) warnings.push("The file has no client_secret. Desktop clients normally include one; sign-in may fail.");
  const masked = maskClientId(info.clientId!);

  let replacedExisting = false;
  let backup: string | undefined;
  if (fs.existsSync(dest)) {
    if (src === dest) return { status: "already-installed", dest, clientIdMasked: masked, warnings };
    const existingText = fs.readFileSync(dest, "utf8");
    if (existingText === text) return { status: "already-installed", dest, clientIdMasked: masked, warnings };
    const existing = inspectClientSecretJson(existingText);
    const ok = await opts.confirmOverwrite({ existingClientId: existing.clientId ? maskClientId(existing.clientId) : undefined, newClientId: masked });
    if (!ok) return { status: "kept-existing", dest, clientIdMasked: existing.clientId ? maskClientId(existing.clientId) : masked, warnings };
    const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    backup = `${dest}.backup-${stamp}`;
    fs.copyFileSync(dest, backup);
    try {
      fs.chmodSync(backup, 0o600);
    } catch {
      /* best effort */
    }
    replacedExisting = true;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const repo = findEnclosingGitRepo(path.dirname(dest));
  if (repo) warnings.push(`The destination is inside a git repository (${repo}). Make sure it is git-ignored, or set YT_MCP_CONFIG_DIR to a folder outside any repository.`);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, dest);
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    /* Windows: permissions come from the user profile folder */
  }
  return { status: replacedExisting ? "replaced" : "imported", dest, clientIdMasked: masked, backup, warnings };
}
