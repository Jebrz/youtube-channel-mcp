import fs from "node:fs";
import path from "node:path";
import { runLogin, type LoginOptions } from "../auth/login.js";
import type { FetchLike } from "../auth/manager.js";
import { inspectClientSecretJson, loadClientCredentials, maskClientId, readTokenFile, writeTokenFile, type ClientCredentials, type StoredToken } from "../auth/store.js";
import { BASE_SCOPES, loadConfig } from "../config.js";
import { YouTubeMcpError } from "../errors.js";
import { LiveCheckError, runLiveCheck } from "./check.js";
import { importClientSecret } from "./clientImport.js";
import {
  REGISTRATION_NAME,
  addRegistration,
  findClaude,
  getRegistration,
  registrationCommandLines,
  removeRegistration,
  serverLaunchCommand,
  type CommandRunner,
  type LaunchCommand,
} from "./claudeCode.js";
import { buildDeps } from "./deps.js";
import { diagnoseFailure } from "./diagnose.js";
import { checkNodeVersion } from "./doctor.js";
import { normalizeUserPath, type PathContext } from "./paths.js";
import { CancelledError, type Prompter } from "./prompt.js";

export interface SetupOptions {
  prompter: Prompter;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  /** The existing Google OAuth flow; injectable for tests. */
  login?: (creds: ClientCredentials, opts: LoginOptions) => Promise<StoredToken>;
  loginFlags?: { manual?: boolean; port?: number };
  fetchImpl?: FetchLike;
  launch?: LaunchCommand;
  pathContext?: PathContext;
  now?: () => Date;
}

export interface SetupResult {
  exitCode: number;
  clientReady: boolean;
  signedIn: boolean;
  channel?: { id: string; title: string | null };
  registered: "yes" | "already" | "skipped" | "unavailable" | "failed";
}

export const GOOGLE_CLOUD_LINKS = {
  dataApi: "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
  analyticsApi: "https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com",
  authPlatform: "https://console.cloud.google.com/auth/overview",
  audience: "https://console.cloud.google.com/auth/audience",
  clients: "https://console.cloud.google.com/auth/clients",
  installedAppGuide: "https://developers.google.com/youtube/v3/guides/auth/installed-apps",
  audienceHelp: "https://support.google.com/cloud/answer/15549945",
};

export function googleCloudChecklist(): string[] {
  const L = GOOGLE_CLOUD_LINKS;
  return [
    "Google Cloud steps you do yourself in a browser (this tool can't do them or check them for you):",
    "  1. Create or pick a Google Cloud project.",
    `  2. Enable "YouTube Data API v3":     ${L.dataApi}`,
    `  3. Enable "YouTube Analytics API":   ${L.analyticsApi}`,
    `  4. Configure Google Auth Platform (consent screen), user type External: ${L.authPlatform}`,
    `  5. Under Audience, add the Google account that owns the channel as a test user: ${L.audience}`,
    `  6. Under Clients, create an OAuth client of type "Desktop app" and download its JSON: ${L.clients}`,
    `  Official guides: ${L.installedAppGuide}`,
    `                   ${L.audienceHelp}`,
    "  Step-by-step instructions: docs/GOOGLE_CLOUD_SETUP.md in the project repository.",
  ];
}

function hasBaseScopes(t: StoredToken | undefined): boolean {
  const granted = (t?.scope ?? "").split(/\s+/);
  return Boolean(t?.refresh_token) && BASE_SCOPES.every((s) => granted.includes(s));
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const p = platform === "win32" ? path.win32 : path.posix;
  const na = p.normalize(a);
  const nb = p.normalize(b);
  return platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
  const P = opts.prompter;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const login = opts.login ?? runLogin;
  const launch = opts.launch ?? serverLaunchCommand(undefined, env);
  const result: SetupResult = { exitCode: 0, clientReady: false, signedIn: false, registered: "skipped" };
  const step = (n: number, title: string) => P.out(`\n── Step ${n}: ${title}`);

  try {
    P.out("youtube-channel-mcp setup");
    P.out("This walks you through LOCAL setup: importing your Google OAuth client, signing in, checking the");
    P.out("connection and registering the server with Claude Code. It does not create Google credentials for");
    P.out("you and does not deploy a hosted server. Press Ctrl+C at any prompt to stop; nothing is half-written.");

    // 1. Runtime
    step(1, "Check Node.js");
    const node = checkNodeVersion(opts.nodeVersion ?? process.version);
    P.out(`${node.status === "ok" ? "OK" : node.status === "warn" ? "Warning" : "Problem"}: ${node.detail}`);
    if (node.next) P.out(`  ${node.next}`);
    if (node.status === "action") return { ...result, exitCode: 1 };

    // 2. Which path
    step(2, "Choose what you're setting up");
    const mode = await P.choose(
      "How will you use the connector?",
      [
        { value: "local", label: "Local: Claude Code on this computer (recommended for most people)" },
        { value: "hosted", label: "Hosted: a server you deploy, for live dashboards inside claude.ai artifacts" },
      ],
      "local",
    );
    if (mode === "hosted") {
      P.out("The hosted connector runs on a server you deploy yourself (see docs/HOSTED_SETUP.md); this command");
      P.out("won't deploy it. It still needs a Google sign-in made on this computer first, which the next steps do.");
    }

    // 3. Detect existing setup
    step(3, "Look for an existing setup");
    const config = loadConfig(env);
    P.out(`Configuration folder: ${config.configDir}`);
    const clientFromEnv = Boolean(env.YT_MCP_CLIENT_ID);
    let clientInfo = !clientFromEnv && fs.existsSync(config.clientSecretFile) ? inspectClientSecretJson(fs.readFileSync(config.clientSecretFile, "utf8")) : undefined;
    const existingToken = env.YT_MCP_REFRESH_TOKEN ? undefined : readTokenFile(config.tokenFile);
    if (clientFromEnv) P.out("OAuth client: provided by the YT_MCP_CLIENT_ID environment variable.");
    else if (!clientInfo) P.out("OAuth client: none saved yet.");
    else if (clientInfo.ok) P.out(`OAuth client: Desktop app client ${maskClientId(clientInfo.clientId!)} (contents not shown).`);
    else P.out(`OAuth client: saved file has a problem: ${clientInfo.problem}`);
    if (env.YT_MCP_REFRESH_TOKEN) P.out("Sign-in: provided by the YT_MCP_REFRESH_TOKEN environment variable.");
    else P.out(`Sign-in: ${existingToken ? (hasBaseScopes(existingToken) ? "saved (contents not shown)." : "saved, but incomplete; you'll sign in again.") : "not signed in yet."}`);

    // 4-6. OAuth client
    step(4, "Google OAuth client");
    let clientChanged = false;
    if (clientFromEnv) {
      result.clientReady = true;
      P.out("Using the client from the environment; nothing to import.");
    } else {
      let wantImport = true;
      if (clientInfo?.ok) {
        wantImport = !(await P.confirm("Keep the OAuth client that's already saved?", true));
      } else {
        for (const line of googleCloudChecklist()) P.out(line);
      }
      if (!wantImport) result.clientReady = true;
      for (let attempt = 0; wantImport && attempt < 5; attempt++) {
        const raw = await P.ask("Path to the downloaded client JSON (drag the file here, or press Enter to stop for now):");
        const src = normalizeUserPath(raw, { platform, env, ...opts.pathContext });
        if (!src) {
          P.out("\nSetup paused. When you have the Desktop app client JSON, run `youtube-channel-mcp setup` again.");
          return { ...result, exitCode: 1 };
        }
        try {
          const r = await importClientSecret({
            sourcePath: src,
            destPath: config.clientSecretFile,
            confirmOverwrite: ({ existingClientId, newClientId }) =>
              P.confirm(`A different client (${existingClientId ?? "unreadable"}) is already saved. Replace it with ${newClientId}? A backup copy is kept.`, false),
            now: opts.now,
          });
          for (const w of r.warnings) P.out(`Warning: ${w}`);
          if (r.status === "kept-existing") {
            P.out("Kept the existing client file unchanged.");
            const kept = inspectClientSecretJson(fs.readFileSync(config.clientSecretFile, "utf8"));
            result.clientReady = kept.ok;
            if (!kept.ok) {
              P.out(`The kept file still has a problem: ${kept.problem}`);
              continue;
            }
          } else {
            P.out(
              r.status === "already-installed"
                ? `That client (${r.clientIdMasked}) is already saved.`
                : `Saved Desktop app client ${r.clientIdMasked} to ${r.dest} (owner-only permissions).${r.backup ? ` Previous file backed up to ${r.backup}.` : ""}`,
            );
            clientChanged = r.status === "replaced";
            result.clientReady = true;
          }
          wantImport = false;
        } catch (e) {
          const d = diagnoseFailure(e);
          P.out(`That file can't be used: ${d.detail}`);
          P.out(`  ${d.next}`);
          if (!(await P.confirm("Try another file?", true))) return { ...result, exitCode: 1 };
        }
      }
      clientInfo = fs.existsSync(config.clientSecretFile) ? inspectClientSecretJson(fs.readFileSync(config.clientSecretFile, "utf8")) : undefined;
      if (!result.clientReady || !clientInfo?.ok) {
        P.out("No usable OAuth client yet. Run `youtube-channel-mcp setup` again when you have the file.");
        return { ...result, exitCode: 1 };
      }
    }

    // 7. Remaining Google Cloud steps (can't be verified locally)
    step(5, "Before signing in");
    P.out("Make sure both APIs are enabled and your Google account is a test user (see the checklist above or");
    P.out("docs/GOOGLE_CLOUD_SETUP.md). This tool can't verify those settings; the live check later will tell you");
    P.out("if an API is still disabled. Google will show an 'unverified app' screen for your own project: that's");
    P.out("expected. Choose the account or Brand Account that owns the channel, and tick every checkbox.");
    P.out("If your consent screen stays in Testing status, Google ends this sign-in after 7 days.");

    // 8. Sign in with the existing OAuth flow
    step(6, "Sign in with Google");
    let freshSignIn = false;
    if (env.YT_MCP_REFRESH_TOKEN) {
      P.out("Sign-in comes from YT_MCP_REFRESH_TOKEN; skipping.");
      result.signedIn = true;
    } else {
      const haveGood = hasBaseScopes(existingToken) && !clientChanged;
      if (clientChanged && existingToken) P.out("You replaced the OAuth client, so the saved sign-in (made with the old client) has to be replaced too.");
      const doLogin = haveGood ? await P.confirm("You're already signed in. Sign in again (for example to switch channels)?", false) : await P.confirm("Open Google sign-in now?", true);
      result.signedIn = haveGood && !doLogin;
      for (let attempt = 0; doLogin && attempt < 3; attempt++) {
        try {
          const creds = loadClientCredentials(config.clientSecretFile, env);
          P.close(); // the sign-in flow may read from the terminal itself (--manual)
          const token = await login(creds, { ...opts.loginFlags, out: (m) => P.out(m) });
          writeTokenFile(config.tokenFile, token);
          P.out(`Signed in. Token saved to ${config.tokenFile} (owner-only permissions).`);
          result.signedIn = true;
          freshSignIn = true;
          break;
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          const d = diagnoseFailure(e);
          P.out(`Sign-in didn't complete: ${d.detail}`);
          P.out(`  ${d.next}`);
          if (!(await P.confirm("Try signing in again?", true))) break;
        }
      }
      if (!result.signedIn) {
        P.out("Not signed in. You can finish later with `youtube-channel-mcp auth`.");
        result.exitCode = 1;
      }
    }

    // 9-10. Show channel / live check
    if (result.signedIn) {
      step(7, "Check the connection");
      const { deps } = buildDeps(env, { fetchImpl: opts.fetchImpl, now: opts.now });
      const run = freshSignIn || (await P.confirm("Run the live connection check now? It makes two read-only requests to Google.", true));
      if (!run) {
        P.out("Skipped. Run `youtube-channel-mcp doctor --live` any time.");
      } else {
        try {
          const r = await runLiveCheck(deps, (l) => P.out(l));
          result.channel = { id: r.channelId, title: r.channelTitle };
          P.out(`Connected channel: ${r.channelTitle ?? "(untitled)"} (ID ${r.channelId})`);
          P.out("If that's not the channel you meant, run `youtube-channel-mcp auth` and pick the right account or Brand Account.");
        } catch (e) {
          const d = diagnoseFailure(e instanceof LiveCheckError ? e.error : e, e instanceof LiveCheckError ? e.step : undefined);
          P.out(`Problem: ${d.title}. ${d.detail}`);
          P.out(`  ${d.next}`);
          result.exitCode = 1;
        }
      }
    }

    // 11. Claude Code registration
    if (mode === "hosted") {
      step(8, "Next steps for the hosted connector");
      P.out("Follow docs/HOSTED_SETUP.md. You'll use `youtube-channel-mcp hash-password` and `youtube-channel-mcp env-export`");
      P.out("there. Nothing has been deployed.");
    } else {
      step(8, "Register with Claude Code");
      result.registered = await registerWithClaude(P, opts.runner, launch, platform);
      if (result.registered === "failed") result.exitCode = 1;
    }

    P.out("\n── Summary");
    P.out(`OAuth client: ${result.clientReady ? "ready" : "missing"}`);
    P.out(`Google sign-in: ${result.signedIn ? "done" : "not done"}`);
    if (result.channel) P.out(`Channel: ${result.channel.title ?? "(untitled)"} (${result.channel.id})`);
    if (mode === "local") P.out(`Claude Code: ${{ yes: "registered", already: "already registered", skipped: "not registered (see command above)", unavailable: "not found (see command above)", failed: "registration failed (see above)" }[result.registered]}`);
    if (mode === "local" && (result.registered === "yes" || result.registered === "already")) {
      P.out("Next: restart Claude Code, type /mcp to confirm \"youtube-channel\" is connected, then ask:");
      P.out('  "Give me an overview of my YouTube channel."');
    }
    P.out("Run `youtube-channel-mcp doctor` any time something doesn't connect.");
    return result;
  } catch (e) {
    if (e instanceof CancelledError) {
      P.out("\nSetup cancelled. Anything already saved stays as it was; run `youtube-channel-mcp setup` to continue.");
      return { ...result, exitCode: 130 };
    }
    if (e instanceof YouTubeMcpError) {
      P.out(`\nSetup stopped: ${e.message}${e.hint ? `\n  ${e.hint}` : ""}`);
      return { ...result, exitCode: 1 };
    }
    throw e;
  } finally {
    P.close();
  }
}

async function registerWithClaude(P: Prompter, runner: CommandRunner | undefined, launch: LaunchCommand, platform: NodeJS.Platform): Promise<SetupResult["registered"]> {
  const cmds = registrationCommandLines(launch);
  const showCommands = () => {
    P.out("To register later, run ONE of these:");
    P.out(`  Windows PowerShell:  ${cmds.powershell}`);
    P.out(`  macOS / Linux:       ${cmds.posix}`);
  };
  if (!runner) {
    showCommands();
    return "skipped";
  }
  const claude = await findClaude(runner);
  if (!claude.available) {
    P.out(`Claude Code wasn't found: ${claude.problem} Your connector setup is still complete.`);
    P.out("Install Claude Code (https://code.claude.com), then register the server.");
    showCommands();
    return "unavailable";
  }
  P.out(`Found Claude Code ${claude.version ?? ""}.`.replace(" .", "."));
  const reg = await getRegistration(runner);
  if ("unknown" in reg) {
    P.out(`Couldn't check the current registration (${reg.problem}).`);
    showCommands();
    return "skipped";
  }
  const target = launch.args[0]!;
  if (reg.exists) {
    if (reg.entryFile && samePath(reg.entryFile, target, platform)) {
      P.out(`"${REGISTRATION_NAME}" is already registered with this installation${reg.scope ? ` (${reg.scope})` : ""}. Nothing to change.`);
      return "already";
    }
    P.out(`An MCP server named "${REGISTRATION_NAME}" already exists${reg.scope ? ` (${reg.scope})` : ""}:`);
    P.out(`  Command: ${reg.command ?? "?"} ${reg.args ?? ""}`);
    if (!(await P.confirm(`Replace it so it points to this installation (${target})?`, false))) {
      P.out("Left the existing registration unchanged.");
      showCommands();
      return "skipped";
    }
    const rm = await removeRegistration(runner);
    if (rm.code !== 0) {
      P.out(`Couldn't remove the old registration (exit ${rm.code ?? rm.error}). Nothing was changed.`);
      return "failed";
    }
  } else if (!(await P.confirm(`Register "${REGISTRATION_NAME}" with Claude Code for your user account (all projects)?`, true))) {
    showCommands();
    return "skipped";
  }
  const add = await addRegistration(runner, launch);
  if (add.code === 0) {
    P.out(`Registered "${REGISTRATION_NAME}": ${launch.command} ${launch.args.join(" ")}`);
    return "yes";
  }
  P.out(`Claude Code didn't accept the registration (exit ${add.code ?? add.error}).`);
  showCommands();
  return "failed";
}
