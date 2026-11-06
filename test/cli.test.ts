import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredToken } from "../src/auth/store.js";
import { inspectClientSecretJson, maskClientId } from "../src/auth/store.js";
import { SCOPES } from "../src/config.js";
import { importClientSecret } from "../src/cli/clientImport.js";
import { parseRegistration, registrationCommandLines, type CommandRunner, type RunResult } from "../src/cli/claudeCode.js";
import { checkNodeVersion, formatDoctorReport, runDoctor } from "../src/cli/doctor.js";
import { normalizeUserPath } from "../src/cli/paths.js";
import { CancelledError, HiddenInputUnavailableError, parseChoice, parseYesNo, readHidden, type Prompter } from "../src/cli/prompt.js";
import { runSetup } from "../src/cli/setup.js";
import { parseFlags } from "../src/index.js";
import { CHANNEL_ID, analyticsResponse, channelResponse, googleError, json, mockFetch, type Handler } from "./helpers.js";

// ---------------------------------------------------------------------------
// Fixtures (fake values only)
// ---------------------------------------------------------------------------
const CLIENT_ID = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-testSecretValueDoNotPrint";
const REFRESH = "1//0testRefreshTokenValueDoNotPrint0123456789";
const desktopJson = (id = CLIENT_ID) => JSON.stringify({ installed: { client_id: id, client_secret: CLIENT_SECRET, redirect_uris: ["http://localhost"] } });
const webJson = JSON.stringify({ web: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });
const goodToken = (extra: Partial<StoredToken> = {}): StoredToken => ({
  access_token: "ya29.testAccessTokenDoNotPrint",
  refresh_token: REFRESH,
  expiry_date: Date.now() + 3_600_000,
  scope: `${SCOPES.youtubeReadonly} ${SCOPES.analyticsReadonly}`,
  token_type: "Bearer",
  ...extra,
});

const dirs: string[] = [];
function tmpDir(name = "yt mcp test "): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), name)); // note the space in the path
  dirs.push(d);
  return d;
}
beforeEach(() => void vi.spyOn(process.stderr, "write").mockImplementation(() => true));
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Scripted prompter: answers are consumed in order; a CancelledError entry simulates Ctrl+C. */
function scripted(answers: Array<string | boolean | Error>) {
  const lines: string[] = [];
  const asked: string[] = [];
  const next = (q: string) => {
    asked.push(q);
    if (!answers.length) throw new Error(`Unexpected prompt: ${q}`);
    const a = answers.shift()!;
    if (a instanceof Error) throw a;
    return a;
  };
  const p: Prompter & { lines: string[]; asked: string[]; text: () => string } = {
    lines,
    asked,
    text: () => lines.join("\n"),
    out: (m = "") => void lines.push(m),
    ask: async (q) => String(next(q)),
    confirm: async (q) => {
      const a = next(q);
      return typeof a === "boolean" ? a : parseYesNo(String(a), false)!;
    },
    choose: async (q, choices, def) => parseChoice(String(next(q)), choices, def)!,
    secret: async (q) => String(next(q)),
    close: () => {},
  };
  return p;
}

/** Fake `claude` CLI. */
function fakeClaude(state: { installed: boolean; registered?: string }) {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(_cmd, args): Promise<RunResult> {
      calls.push(args);
      if (!state.installed) return { code: null, stdout: "", stderr: "", error: "not_found" };
      if (args[0] === "--version") return { code: 0, stdout: "2.1.318 (Claude Code)\n", stderr: "" };
      if (args[0] === "mcp" && args[1] === "get") {
        if (!state.registered) return { code: 1, stdout: 'No MCP server named "youtube-channel". Run `claude mcp add` to add one.\n', stderr: "" };
        return {
          code: 0,
          stdout: `youtube-channel:\n  Scope: User config (available in all your projects)\n  Status: ✓ Connected\n  Type: stdio\n  Command: node\n  Args: ${state.registered} serve\n  Environment:\n    SECRET_THING=supersecretvalue\n`,
          stderr: "",
        };
      }
      if (args[0] === "mcp" && args[1] === "remove") {
        state.registered = undefined;
        return { code: 0, stdout: "Removed", stderr: "" };
      }
      if (args[0] === "mcp" && args[1] === "add") {
        state.registered = args[args.indexOf("--") + 2];
        return { code: 0, stdout: "Added", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unknown" };
    },
  };
  return { runner, calls, state };
}

const googleOk: Handler = (u) => {
  if (u.pathname.endsWith("/channels")) return json(200, channelResponse());
  if (u.hostname === "youtubeanalytics.googleapis.com") return json(200, analyticsResponse([["views", "METRIC", "INTEGER"], ["estimatedMinutesWatched", "METRIC", "INTEGER"]], [[42, 7]]));
  return undefined;
};

function writeConfig(dir: string, files: { client?: string; token?: StoredToken | string }) {
  fs.mkdirSync(dir, { recursive: true });
  if (files.client !== undefined) fs.writeFileSync(path.join(dir, "client_secret.json"), files.client);
  if (files.token !== undefined) fs.writeFileSync(path.join(dir, "token.json"), typeof files.token === "string" ? files.token : JSON.stringify(files.token));
}

const SECRET_VALUES = [CLIENT_SECRET, REFRESH, "ya29.testAccessTokenDoNotPrint", "supersecretvalue", "testSecretValue"];
function expectNoSecrets(text: string) {
  for (const s of SECRET_VALUES) expect(text).not.toContain(s);
}

// ---------------------------------------------------------------------------
describe("offline guard", () => {
  it("fails unexpected real network requests", async () => {
    await expect(fetch("https://www.googleapis.com/youtube/v3/channels")).rejects.toThrow(/Unexpected network request/);
  });
});

describe("user path normalization", () => {
  const winCtx = { platform: "win32" as const, homedir: "C:\\Users\\Jo Smith", cwd: "C:\\work", env: { USERPROFILE: "C:\\Users\\Jo Smith" } };
  const posixCtx = { platform: "linux" as const, homedir: "/home/jo", cwd: "/work", env: {} };

  it("handles Windows paths with spaces, quotes, drag-and-drop and env vars", () => {
    const want = "C:\\Users\\Jo Smith\\My Downloads\\client_secret_1.json";
    expect(normalizeUserPath(`"${want}"`, winCtx)).toBe(want);
    expect(normalizeUserPath(`'${want}'`, winCtx)).toBe(want);
    expect(normalizeUserPath(`& '${want}'`, winCtx)).toBe(want);
    expect(normalizeUserPath(`  ${want}  `, winCtx)).toBe(want);
    expect(normalizeUserPath("%USERPROFILE%\\My Downloads\\client_secret_1.json", winCtx)).toBe(want);
    expect(normalizeUserPath("~\\My Downloads\\client_secret_1.json", winCtx)).toBe(want);
    expect(normalizeUserPath("client.json", winCtx)).toBe("C:\\work\\client.json");
  });

  it("handles macOS/Linux escaped spaces, quotes and ~", () => {
    expect(normalizeUserPath("/home/jo/My\\ Downloads/c.json", posixCtx)).toBe("/home/jo/My Downloads/c.json");
    expect(normalizeUserPath("'/home/jo/My Downloads/c.json'", posixCtx)).toBe("/home/jo/My Downloads/c.json");
    expect(normalizeUserPath("~/Downloads/c.json", posixCtx)).toBe("/home/jo/Downloads/c.json");
    expect(normalizeUserPath("   ", posixCtx)).toBeUndefined();
    expect(normalizeUserPath('""', posixCtx)).toBeUndefined();
  });
});

describe("OAuth client inspection and import", () => {
  it("accepts Desktop clients and explains every other kind", () => {
    expect(inspectClientSecretJson(desktopJson())).toMatchObject({ ok: true, kind: "desktop", hasClientSecret: true });
    expect(inspectClientSecretJson("\uFEFF" + desktopJson()).ok).toBe(true); // BOM from Windows editors
    expect(inspectClientSecretJson(webJson)).toMatchObject({ ok: false, kind: "web", problem: expect.stringMatching(/Web application/) });
    expect(inspectClientSecretJson(JSON.stringify({ type: "service_account", private_key: "x" }))).toMatchObject({ ok: false, problem: expect.stringMatching(/service-account/) });
    expect(inspectClientSecretJson("{not json")).toMatchObject({ ok: false, problem: expect.stringMatching(/not valid JSON/) });
    expect(inspectClientSecretJson("[]").ok).toBe(false);
    expect(inspectClientSecretJson(JSON.stringify({ installed: {} }))).toMatchObject({ ok: false, problem: expect.stringMatching(/client_id/) });
    expect(inspectClientSecretJson(desktopJson("cid")).warning).toMatch(/doesn't look like/);
    // No secret values in any result
    expectNoSecrets(JSON.stringify([inspectClientSecretJson(desktopJson()), inspectClientSecretJson(webJson)]));
    expect(maskClientId(CLIENT_ID)).toBe("1234…apps.googleusercontent.com");
  });

  it("imports a valid file from a path with spaces into the config folder with owner-only permissions", async () => {
    const src = path.join(tmpDir("My Downloads "), "client_secret_123.json");
    fs.writeFileSync(src, desktopJson());
    const dest = path.join(tmpDir(), "config dir", "client_secret.json");
    const confirm = vi.fn();
    const r = await importClientSecret({ sourcePath: src, destPath: dest, confirmOverwrite: confirm });
    expect(r.status).toBe("imported");
    expect(fs.readFileSync(dest, "utf8")).toBe(desktopJson());
    if (process.platform !== "win32") expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
    expect(confirm).not.toHaveBeenCalled();
    expectNoSecrets(JSON.stringify(r));
  });

  it("rejects invalid files without touching the destination", async () => {
    const dir = tmpDir();
    const dest = path.join(dir, "cfg", "client_secret.json");
    const web = path.join(dir, "web.json");
    fs.writeFileSync(web, webJson);
    await expect(importClientSecret({ sourcePath: web, destPath: dest, confirmOverwrite: vi.fn() })).rejects.toMatchObject({ code: "CONFIG_ERROR", hint: expect.stringMatching(/Desktop app/) });
    await expect(importClientSecret({ sourcePath: path.join(dir, "missing.json"), destPath: dest, confirmOverwrite: vi.fn() })).rejects.toThrow(/No file found/);
    await expect(importClientSecret({ sourcePath: dir, destPath: dest, confirmOverwrite: vi.fn() })).rejects.toThrow(/is a folder/);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("never overwrites an existing different client without consent, and keeps a backup when allowed", async () => {
    const dir = tmpDir();
    const dest = path.join(dir, "client_secret.json");
    const other = desktopJson("999999999999-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.apps.googleusercontent.com");
    fs.writeFileSync(dest, other);
    const src = path.join(dir, "new client.json");
    fs.writeFileSync(src, desktopJson());

    const declined = await importClientSecret({ sourcePath: src, destPath: dest, confirmOverwrite: async () => false });
    expect(declined.status).toBe("kept-existing");
    expect(fs.readFileSync(dest, "utf8")).toBe(other);

    const accepted = await importClientSecret({ sourcePath: src, destPath: dest, confirmOverwrite: async () => true, now: () => new Date("2026-11-06T00:00:00Z") });
    expect(accepted.status).toBe("replaced");
    expect(fs.readFileSync(dest, "utf8")).toBe(desktopJson());
    expect(fs.readFileSync(accepted.backup!, "utf8")).toBe(other);

    const again = await importClientSecret({ sourcePath: src, destPath: dest, confirmOverwrite: vi.fn() });
    expect(again.status).toBe("already-installed");
  });
});

describe("prompt helpers", () => {
  it("parses yes/no and numbered choices", () => {
    expect(parseYesNo("", true)).toBe(true);
    expect(parseYesNo("No", true)).toBe(false);
    expect(parseYesNo("maybe", true)).toBeUndefined();
    const choices = [{ value: "local", label: "L" }, { value: "hosted", label: "H" }] as const;
    expect(parseChoice("2", [...choices], "local")).toBe("hosted");
    expect(parseChoice("", [...choices], "local")).toBe("local");
    expect(parseChoice("9", [...choices], "local")).toBeUndefined();
  });

  function fakeTty(isTTY = true) {
    const s = new EventEmitter() as EventEmitter & { isTTY: boolean; isRaw: boolean; setRawMode: (b: boolean) => void; resume: () => void; pause: () => void; rawCalls: boolean[] };
    s.isTTY = isTTY;
    s.isRaw = false;
    s.rawCalls = [];
    s.setRawMode = (b) => {
      s.isRaw = b;
      s.rawCalls.push(b);
    };
    s.resume = () => {};
    s.pause = () => {};
    return s;
  }
  const sink = () => {
    let text = "";
    return { write: (c: string) => ((text += c), true), get text() { return text; } };
  };

  it("reads hidden input without echoing it and restores the terminal", async () => {
    const tty = fakeTty();
    const out = sink();
    const p = readHidden("Passphrase: ", tty as never, out as never);
    tty.emit("data", "corr");
    tty.emit("data", "\u001b[A"); // arrow key ignored
    tty.emit("data", "ectx\u007f horse\r");
    await expect(p).resolves.toBe("correct horse");
    expect(out.text).toBe("Passphrase: \n");
    expect(tty.rawCalls).toEqual([true, false]);
    expect(tty.isRaw).toBe(false);
  });

  it("Ctrl+C cancels hidden input and restores the terminal", async () => {
    const tty = fakeTty();
    const p = readHidden("Passphrase: ", tty as never, sink() as never);
    tty.emit("data", "secret\u0003");
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(tty.isRaw).toBe(false);
    expect(tty.listenerCount("data")).toBe(0);
  });

  it("refuses (rather than echoing) when hidden input isn't available", async () => {
    await expect(readHidden("Passphrase: ", fakeTty(false) as never, sink() as never)).rejects.toBeInstanceOf(HiddenInputUnavailableError);
  });

  it("validates --port", () => {
    expect(parseFlags(["--port", "8976"]).port).toBe(8976);
    expect(() => parseFlags(["--port"])).toThrow(/--port must be/);
    expect(() => parseFlags(["--port", "80abc"])).toThrow(/--port must be/);
    expect(() => parseFlags(["--port", "70000"])).toThrow(/--port must be/);
  });
});

describe("Claude Code registration helpers", () => {
  it("parses `claude mcp get` without keeping the Environment section", () => {
    const reg = parseRegistration(
      "youtube-channel:\n  Scope: User config\n  Status: ✓ Connected\n  Command: node\n  Args: C:\\Users\\Jo Smith\\yt mcp\\dist\\index.js serve\n  Environment:\n    API_KEY=supersecretvalue\n",
    );
    expect(reg).toMatchObject({ exists: true, scope: "User config", command: "node", entryFile: "C:\\Users\\Jo Smith\\yt mcp\\dist\\index.js" });
    expectNoSecrets(JSON.stringify(reg));
  });

  it("passes custom path settings (never secrets) to Claude Code", async () => {
    const { serverLaunchCommand, registrationArgs } = await import("../src/cli/claudeCode.js");
    const launch = serverLaunchCommand("/x/dist/index.js", {
      YT_MCP_CONFIG_DIR: "/home/jo/yt config",
      YT_MCP_CLIENT_SECRET: "GOCSPX-testSecretValueDoNotPrint",
      YT_MCP_REFRESH_TOKEN: REFRESH,
    });
    const args = registrationArgs(launch);
    expect(args).toEqual(["mcp", "add", "youtube-channel", "--scope", "user", "-e", "YT_MCP_CONFIG_DIR=/home/jo/yt config", "--", "node", "/x/dist/index.js", "serve"]);
    expectNoSecrets(args.join(" "));
  });

  it("produces copyable commands that quote paths with spaces", () => {
    const c = registrationCommandLines({ command: "node", args: ["C:\\Users\\Jo Smith\\yt mcp\\dist\\index.js", "serve"] });
    expect(c.powershell).toBe("claude mcp add youtube-channel --scope user -- node 'C:\\Users\\Jo Smith\\yt mcp\\dist\\index.js' serve");
    const p = registrationCommandLines({ command: "node", args: ["/home/jo/yt mcp/dist/index.js", "serve"] });
    expect(p.posix).toBe("claude mcp add youtube-channel --scope user -- node '/home/jo/yt mcp/dist/index.js' serve");
  });
});

// ---------------------------------------------------------------------------
describe("doctor", () => {
  // A real file standing in for dist/index.js, so tests don't depend on a build.
  const entryDir = fs.mkdtempSync(path.join(os.tmpdir(), "yt entry "));
  const entry = path.join(entryDir, "index.js");
  fs.writeFileSync(entry, "// stand-in\n");
  const launch = { command: "node", args: [entry, "serve"] };

  it("reports a fresh install offline, makes no network requests, and exits nonzero", async () => {
    const env = { YT_MCP_CONFIG_DIR: path.join(tmpDir(), "cfg") };
    const fetchImpl = mockFetch();
    const r = await runDoctor({ env, fetchImpl, runner: fakeClaude({ installed: false }).runner, launch, nodeVersion: "v22.12.0" });
    const byId = Object.fromEntries(r.results.map((x) => [x.id, x]));
    expect(byId["oauth-client"]!.status).toBe("action");
    expect(byId["sign-in"]!.status).toBe("action");
    expect(byId["claude-code"]!.status).toBe("warn");
    expect(byId["claude-code"]!.next).toMatch(/claude mcp add youtube-channel/);
    expect(byId.live!.detail).toMatch(/no network requests/);
    expect(fetchImpl.calls).toHaveLength(0);
    expect(r.exitCode).toBe(1);
  });

  it("is all OK for a complete setup and never prints secrets", async () => {
    const dir = path.join(tmpDir(), "cfg");
    writeConfig(dir, { client: desktopJson(), token: goodToken({ obtained_at: new Date().toISOString() }) });
    if (process.platform !== "win32") {
      fs.chmodSync(path.join(dir, "client_secret.json"), 0o600);
      fs.chmodSync(path.join(dir, "token.json"), 0o600);
    }
    const claude = fakeClaude({ installed: true, registered: launch.args[0] });
    const fetchImpl = mockFetch(googleOk);
    const r = await runDoctor({ env: { YT_MCP_CONFIG_DIR: dir }, live: true, fetchImpl, runner: claude.runner, launch, nodeVersion: "v24.1.0" });
    expect(r.results.filter((x) => x.status !== "ok")).toEqual([]);
    expect(r.exitCode).toBe(0);
    const text = formatDoctorReport(r) + JSON.stringify(r);
    expectNoSecrets(text);
    expect(text).toContain(CHANNEL_ID);
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it("flags Web clients, broken token files, missing scopes and old Node", async () => {
    const dir = path.join(tmpDir(), "cfg");
    writeConfig(dir, { client: webJson, token: "{oops" });
    let r = await runDoctor({ env: { YT_MCP_CONFIG_DIR: dir }, checkClaude: false, nodeVersion: "v18.20.0" });
    const ids = (s: string) => r.results.find((x) => x.id === s)!;
    expect(ids("node").status).toBe("action");
    expect(ids("oauth-client").detail).toMatch(/Web application/);
    expect(ids("sign-in").detail).toMatch(/not valid JSON/);
    writeConfig(dir, { client: desktopJson(), token: goodToken({ scope: SCOPES.youtubeReadonly }) });
    r = await runDoctor({ env: { YT_MCP_CONFIG_DIR: dir }, checkClaude: false, nodeVersion: "v22.12.0" });
    expect(ids("sign-in")).toMatchObject({ status: "action", next: expect.stringMatching(/yt-analytics.readonly/) });
    expect(checkNodeVersion("v20.11.0").status).toBe("warn");
  });

  it("warns about Testing-mode expiry after 7 days and when a registration points to a missing file", async () => {
    const dir = path.join(tmpDir(), "cfg");
    writeConfig(dir, { client: desktopJson(), token: goodToken({ obtained_at: "2026-10-01T00:00:00Z" }) });
    const claude = fakeClaude({ installed: true, registered: path.join(tmpDir(), "gone", "index.js") });
    const r = await runDoctor({ env: { YT_MCP_CONFIG_DIR: dir }, runner: claude.runner, launch, nodeVersion: "v22.12.0", now: () => new Date("2026-11-06T00:00:00Z") });
    expect(r.results.find((x) => x.id === "sign-in")).toMatchObject({ status: "warn", next: expect.stringMatching(/Testing/) });
    expect(r.results.find((x) => x.id === "claude-code")).toMatchObject({ status: "action", detail: expect.stringMatching(/doesn't exist/) });
    expectNoSecrets(formatDoctorReport(r));
  });

  describe("--live distinguishes failure causes", () => {
    async function liveWith(handler: Handler, envExtra: Record<string, string> = {}, token = goodToken()) {
      const dir = path.join(tmpDir(), "cfg");
      writeConfig(dir, { client: desktopJson(), token });
      const r = await runDoctor({ env: { YT_MCP_CONFIG_DIR: dir, ...envExtra }, live: true, checkClaude: false, fetchImpl: mockFetch(handler), nodeVersion: "v22.12.0" });
      const live = r.results.find((x) => x.id === "live")!;
      expectNoSecrets(formatDoctorReport(r));
      return { live, r };
    }

    it("API disabled", async () => {
      const { live } = await liveWith(() => googleError(403, "accessNotConfigured", "YouTube Data API v3 has not been used in project 123 before or it is disabled."));
      expect(live).toMatchObject({ status: "action", title: expect.stringMatching(/API not enabled/), next: expect.stringMatching(/YouTube Data API v3/) });
    });
    it("missing permissions", async () => {
      const { live } = await liveWith(() => googleError(403, "insufficientPermissions", "Request had insufficient authentication scopes."));
      expect(live.title).toMatch(/Missing permissions/);
    });
    it("expired / revoked sign-in", async () => {
      const { live } = await liveWith(
        (u) => (u.hostname === "oauth2.googleapis.com" ? json(400, { error: "invalid_grant" }) : undefined),
        {},
        goodToken({ access_token: undefined, expiry_date: 0 }),
      );
      expect(live).toMatchObject({ title: expect.stringMatching(/expired or revoked/), next: expect.stringMatching(/7 days/) });
    });
    it("quota", async () => {
      const { live } = await liveWith(() => googleError(403, "quotaExceeded", "Quota exceeded"));
      expect(live.title).toMatch(/Quota/);
    });
    it("network", async () => {
      const { live } = await liveWith(() => {
        throw new TypeError("fetch failed");
      });
      expect(live.title).toMatch(/Network problem/);
    });
    it("analytics refused after the channel read worked", async () => {
      const { live } = await liveWith((u) => (u.pathname.endsWith("/channels") ? json(200, channelResponse()) : googleError(403, "forbidden", "Forbidden")));
      expect(live).toMatchObject({ title: expect.stringMatching(/Analytics request refused/), detail: expect.stringMatching(/analytics query/) });
    });
    it("channel mismatch when an expected channel is configured", async () => {
      const { live } = await liveWith(googleOk, { YT_MCP_EXPECTED_CHANNEL_ID: "UCzzzzzzzzzzzzzzzzzzzzzz" });
      expect(live.title).toMatch(/Different channel/);
    });
    it("account without a channel", async () => {
      const { live } = await liveWith(() => json(200, { items: [] }));
      expect(live).toMatchObject({ title: expect.stringMatching(/No YouTube channel/), next: expect.stringMatching(/Brand Account/) });
    });
  });
});

// ---------------------------------------------------------------------------
describe("setup", () => {
  const launch = { command: "node", args: ["/opt/yt mcp/dist/index.js", "serve"] };

  function base(dir: string, extra: Partial<Parameters<typeof runSetup>[0]> = {}) {
    return {
      env: { YT_MCP_CONFIG_DIR: dir },
      nodeVersion: "v22.12.0",
      launch,
      fetchImpl: mockFetch(googleOk),
      login: vi.fn(async () => goodToken({ obtained_at: new Date().toISOString() })),
      ...extra,
    };
  }

  it("fresh local setup: imports a quoted path with spaces, signs in, checks, registers", async () => {
    const dir = path.join(tmpDir(), "config dir");
    const src = path.join(tmpDir("My Downloads "), "client_secret_1.json");
    fs.writeFileSync(src, desktopJson());
    const claude = fakeClaude({ installed: true });
    const P = scripted(["1", `"${src}"`, true, true]);
    const opts = base(dir, { prompter: P, runner: claude.runner });
    const r = await runSetup(opts);
    expect(r).toMatchObject({ exitCode: 0, clientReady: true, signedIn: true, registered: "yes", channel: { id: CHANNEL_ID } });
    expect(fs.readFileSync(path.join(dir, "client_secret.json"), "utf8")).toBe(desktopJson());
    expect(JSON.parse(fs.readFileSync(path.join(dir, "token.json"), "utf8")).refresh_token).toBe(REFRESH);
    expect(opts.login).toHaveBeenCalledTimes(1);
    expect(claude.calls.find((a) => a[1] === "add")).toEqual(["mcp", "add", "youtube-channel", "--scope", "user", "--", "node", "/opt/yt mcp/dist/index.js", "serve"]);
    expect(P.text()).toMatch(/Connected channel: Test Channel/);
    expect(P.text()).toMatch(/console\.cloud\.google\.com\/apis\/library\/youtubeanalytics\.googleapis\.com/);
    expectNoSecrets(P.text());
  });

  it("cancelling with Ctrl+C at the path prompt changes nothing", async () => {
    const dir = path.join(tmpDir(), "cfg");
    const P = scripted(["1", new CancelledError()]);
    const r = await runSetup(base(dir, { prompter: P, runner: fakeClaude({ installed: true }).runner }));
    expect(r.exitCode).toBe(130);
    expect(fs.existsSync(path.join(dir, "client_secret.json"))).toBe(false);
    expect(P.text()).toMatch(/Setup cancelled/);
  });

  it("pressing Enter at the path prompt pauses setup", async () => {
    const dir = path.join(tmpDir(), "cfg");
    const r = await runSetup(base(dir, { prompter: scripted(["1", ""]), runner: fakeClaude({ installed: true }).runner }));
    expect(r.exitCode).toBe(1);
    expect(r.clientReady).toBe(false);
  });

  it("explains an invalid file and lets the user try another", async () => {
    const dir = path.join(tmpDir(), "cfg");
    const d = tmpDir();
    fs.writeFileSync(path.join(d, "web.json"), webJson);
    fs.writeFileSync(path.join(d, "desktop.json"), desktopJson());
    const P = scripted(["1", path.join(d, "web.json"), true, path.join(d, "desktop.json"), true, true]);
    const r = await runSetup(base(dir, { prompter: P, runner: fakeClaude({ installed: true }).runner }));
    expect(r.exitCode).toBe(0);
    expect(P.text()).toMatch(/Web application/);
  });

  it("preserves an existing setup: keeps client, skips re-sign-in, and leaves a different registration alone", async () => {
    const dir = path.join(tmpDir(), "cfg");
    const token = goodToken();
    writeConfig(dir, { client: desktopJson(), token });
    const before = { client: fs.readFileSync(path.join(dir, "client_secret.json"), "utf8"), token: fs.readFileSync(path.join(dir, "token.json"), "utf8") };
    const claude = fakeClaude({ installed: true, registered: "/somewhere/else/index.js" });
    // mode, keep client?, sign in again?, run live check?, replace registration?
    const P = scripted(["1", true, false, true, false]);
    const opts = base(dir, { prompter: P, runner: claude.runner });
    const r = await runSetup(opts);
    expect(r).toMatchObject({ exitCode: 0, signedIn: true, registered: "skipped" });
    expect(opts.login).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dir, "client_secret.json"), "utf8")).toBe(before.client);
    expect(fs.readFileSync(path.join(dir, "token.json"), "utf8")).toBe(before.token);
    expect(claude.state.registered).toBe("/somewhere/else/index.js");
    expect(claude.calls.some((a) => a[1] === "add" || a[1] === "remove")).toBe(false);
    expectNoSecrets(P.text());
  });

  it("asks before replacing an existing registration", async () => {
    const dir = path.join(tmpDir(), "cfg");
    writeConfig(dir, { client: desktopJson(), token: goodToken() });
    const claude = fakeClaude({ installed: true, registered: "/old/place/index.js" });
    const r = await runSetup(base(dir, { prompter: scripted(["1", true, false, false, true]), runner: claude.runner }));
    expect(r.registered).toBe("yes");
    expect(claude.state.registered).toBe("/opt/yt mcp/dist/index.js");
  });

  it("declining to overwrite an existing client keeps it", async () => {
    const dir = path.join(tmpDir(), "cfg");
    const other = desktopJson("999999999999-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.apps.googleusercontent.com");
    writeConfig(dir, { client: other, token: goodToken() });
    const src = path.join(tmpDir(), "new.json");
    fs.writeFileSync(src, desktopJson());
    // mode, keep client? no, path, replace? no, sign in again? no, live check? no, register? no
    const r = await runSetup(base(dir, { prompter: scripted(["1", false, src, false, false, false, false]), runner: fakeClaude({ installed: true }).runner }));
    expect(fs.readFileSync(path.join(dir, "client_secret.json"), "utf8")).toBe(other);
    expect(r.clientReady).toBe(true);
  });

  it("without Claude Code, finishes the connector setup and prints both registration commands", async () => {
    const dir = path.join(tmpDir(), "cfg");
    writeConfig(dir, { client: desktopJson(), token: goodToken() });
    const P = scripted(["1", true, false, false]);
    const r = await runSetup(base(dir, { prompter: P, runner: fakeClaude({ installed: false }).runner }));
    expect(r).toMatchObject({ exitCode: 0, registered: "unavailable" });
    expect(P.text()).toMatch(/Windows PowerShell: +claude mcp add youtube-channel --scope user -- node '\/opt\/yt mcp\/dist\/index.js' serve/);
    expect(P.text()).toMatch(/macOS \/ Linux: +claude mcp add/);
  });

  it("reports a failed sign-in clearly and does not save a token", async () => {
    const dir = path.join(tmpDir(), "cfg");
    writeConfig(dir, { client: desktopJson() });
    const { AuthRequiredError } = await import("../src/errors.js");
    const login = vi.fn(async () => {
      throw new AuthRequiredError("Google sign-in was not completed: access_denied", undefined, "sign_in_failed");
    });
    // mode, keep client, open sign-in?, try again? no, register? no
    const P = scripted(["1", true, true, false, false]);
    const r = await runSetup(base(dir, { prompter: P, runner: fakeClaude({ installed: true }).runner, login }));
    expect(r).toMatchObject({ exitCode: 1, signedIn: false });
    expect(fs.existsSync(path.join(dir, "token.json"))).toBe(false);
    expect(P.text()).toMatch(/access_denied/);
  });

  it("hosted mode prepares sign-in but never registers or deploys", async () => {
    const dir = path.join(tmpDir(), "cfg");
    writeConfig(dir, { client: desktopJson(), token: goodToken() });
    const claude = fakeClaude({ installed: true });
    const P = scripted(["2", true, false, false]);
    const r = await runSetup(base(dir, { prompter: P, runner: claude.runner }));
    expect(r.exitCode).toBe(0);
    expect(claude.calls).toHaveLength(0);
    expect(P.text()).toMatch(/HOSTED_SETUP/);
  });
});
