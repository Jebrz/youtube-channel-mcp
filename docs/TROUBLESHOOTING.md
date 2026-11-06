# Troubleshooting

Start with:

```bash
youtube-channel-mcp doctor
```

Then, if the basic checks pass:

```bash
youtube-channel-mcp doctor --live
```

`doctor` prints **OK**, **WARN** or **ACTION** for each check with a next step, never prints secrets,
and exits with code 1 when something needs action. Fix ACTION items from top to bottom.

If `youtube-channel-mcp` isn't found, run the same commands from the project folder as
`node dist/index.js doctor`.

The **Source** column says where each entry comes from: *seen* = happened while building or using
this project; *documented* = described in Google's, Anthropic's or npm's documentation; *expected* =
follows from how the code works.

| Symptom | Likely cause | What to do | Source |
| --- | --- | --- | --- |
| `youtube-channel-mcp` "is not recognized" / "command not found" | `npm link` not run, failed, or the terminal was opened before it | Run `npm link` in the project folder and open a new terminal, or use `node dist/index.js <command>` from the project folder | expected |
| PowerShell: "running scripts is disabled on this system" when running `npm` or `youtube-channel-mcp` | PowerShell execution policy blocks the `.ps1` shims npm creates | Use `npm.cmd` / `youtube-channel-mcp.cmd`, or allow local scripts for your user: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (read Microsoft's guidance first) | documented |
| `doctor`: Node.js too old, or `npm install` warns about `engines` | Node older than 22.12 | Install the current LTS from nodejs.org and open a new terminal | documented |
| `setup`: "This is a 'Web application' OAuth client" | Wrong client type downloaded | In Google Cloud Console → Clients, create a **Desktop app** client and download its JSON | expected |
| `setup`: "service-account key" | A service-account key was downloaded instead of an OAuth client | Service accounts can't read a personal channel; create a Desktop app OAuth client | expected |
| `setup`: "No file found" | Path typo or the file is still in a zip | Drag the file into the terminal window; on Windows use Shift + right-click → **Copy as path** | expected |
| Browser shows "Google hasn't verified this app" | Your own unverified project | Click **Continue** (you're the developer). See README → Testing mode | documented |
| Browser shows "Access blocked" / "access_denied" | Your account isn't a test user, or you clicked Cancel | Add the account under Google Auth Platform → Audience → Test users, then run `youtube-channel-mcp auth` | documented |
| `doctor`: "Missing: yt-analytics.readonly" or `--live`: **Missing permissions** | A checkbox was left unticked on the consent screen | Run `youtube-channel-mcp auth` and tick every box | expected |
| `--live`: **Sign-in expired or revoked** (`invalid_grant`), about a week after signing in | Consent screen in **Testing**: Google expires refresh tokens after 7 days | Run `youtube-channel-mcp auth`. For longer-lived use see README → Testing mode | documented |
| `--live`: **API not enabled** (`accessNotConfigured`) | YouTube Data API v3 or YouTube Analytics API is off for the client's project | Enable both in APIs & Services → Library, wait a few minutes, retry | documented |
| `--live`: **OAuth client rejected** (`invalid_client`) | The client was deleted, or you imported a different client than the one you signed in with | `youtube-channel-mcp setup` → import the current client → sign in again | expected |
| `--live`: **No YouTube channel on this account** | Signed in with a personal account; the channel belongs to a Brand Account | `youtube-channel-mcp auth` and choose the **brand channel** on Google's account chooser | documented |
| `--live` or a tool: **Quota or rate limit** (`QUOTA_EXCEEDED`) | Daily quota used up (resets at midnight Pacific Time) or short-term rate limit | Wait. The dashboard cache keeps showing the last good data, marked stale | documented |
| `--live`: **Network problem** | No internet, VPN or proxy blocking Google | Check the connection and retry | expected |
| Sign-in page never comes back / "site can't be reached" on `127.0.0.1` | Browser on a different machine than the terminal (SSH, remote desktop) | `youtube-channel-mcp auth --manual` and paste the redirected URL | expected |
| Sign-in fails to start: port in use | A fixed `--port` is taken | Omit `--port` (a random free port is used) or pick another | expected |
| `/mcp` in Claude Code doesn't list **youtube-channel** | Not registered, or registered from a folder that was moved | `youtube-channel-mcp doctor` shows the exact `claude mcp add …` command | seen |
| `doctor`: registration "points to … which doesn't exist" | Project folder moved or deleted after registering | `claude mcp remove youtube-channel`, then the add command `doctor` prints | expected |
| Tools return `AUTH_REQUIRED: Not signed in` | `setup`/`auth` not completed in the same configuration folder that Claude Code uses | Run `youtube-channel-mcp doctor`; if you use `YT_MCP_CONFIG_DIR`, pass it to Claude Code too (`claude mcp add … -e YT_MCP_CONFIG_DIR=…`) | expected |
| Published artifact shows `server_not_connected` | Artifacts can't call local (Claude Code) servers, or the connector name doesn't match | Use the hosted connector (Path B) and name it exactly as the page expects | seen |
| Connector added in claude.ai but its tools aren't available in a chat or session | Connector not enabled for that chat/session | Enable it for the chat (or start a new session) in claude.ai | seen |
| Comparison shows "n/a" or "no data for the comparison period" | The comparison period is before the channel existed, or its value was 0 | Expected; choose a shorter period whose comparison falls after the channel started | seen |
| Days missing in daily charts | No data that day (before the channel existed, or the 2–3 day reporting lag) | Expected; shown as unavailable, not zero | seen |
| Country rows add up to fewer views than the total | YouTube doesn't attribute every view to a country | Expected; country shares cover attributed views only | seen |
| Demographics empty | YouTube withholds demographics for small audiences | Expected | documented |
| Revenue metrics: `AUTH_REQUIRED` / 403 | Monetary permission not granted, or channel not in the YouTube Partner Program | `youtube-channel-mcp auth --monetary` (YPP channels only) | documented |
| Hosted: `curl …/healthz` returns 404 on Cloud Run | Cloud Run reserves some paths ending in "z" | Use `/health`; `/healthz` is only a compatibility alias | documented |
| Hosted: `serve-http` exits with "PORT must be …" / "… must be between …" | Invalid numeric setting | Use whole numbers in range: `PORT` 1–65535, `YT_MCP_DASHBOARD_TTL_SECONDS` 60–86400, `YT_MCP_TRUST_PROXY` true/false/0–10 | expected |
| `hash-password`: "Hidden input isn't available" | Not running in an interactive terminal | Run it in a normal terminal window, or pipe explicitly: `… \| youtube-channel-mcp hash-password --stdin` | expected |
| Hosted: `CHANNEL_MISMATCH` | The server's Google sign-in belongs to a different channel than `YT_MCP_EXPECTED_CHANNEL_ID` | Re-export credentials from the right account, or fix the setting | expected |

## Still stuck?

Open an issue with the output of `youtube-channel-mcp doctor --live`. It contains no tokens or
secrets, but it does contain your configuration path and channel name and ID; remove them if you
prefer. Never paste `env-export` output, `client_secret.json` or `token.json` anywhere.
