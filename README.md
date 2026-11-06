# youtube-channel-mcp

Let Claude read **your own** YouTube channel's content and analytics, read-only, through Google's
official APIs (YouTube Data API v3 and YouTube Analytics API).

It's an [MCP](https://modelcontextprotocol.io) server: a small program that gives Claude a set of
tools such as "get my channel overview" or "get analytics for this video". It never changes
anything on your channel.

> **Status:** v0.2.0, early. See [What has been verified](#what-has-been-verified) for exactly
> what has and hasn't been tested with a real channel.

---

## Choose your path

| | A. Local MCP for Claude Code | B. Self-hosted remote connector | C. Channel-audit skill |
| --- | --- | --- | --- |
| **What you get** | Ask Claude Code about your channel on your own computer | Live data in claude.ai chats and published artifacts (dashboards) | A ready-made, consistent channel audit report |
| **Needs** | Node.js 22+, a Google Cloud project, Claude Code | Everything in A, plus a server you deploy (e.g. Google Cloud Run) | A working connector from A or B |
| **You're responsible for** | Your Google Cloud project and OAuth client | Also: hosting, its security, costs and updates | Reviewing the report's recommendations |
| **Realistic first-time effort** | 20–40 minutes, mostly the Google Cloud steps | 1–2 hours more, if you're comfortable with the command line and cloud consoles | About 5 minutes once A or B works |
| **Start here** | [Path A](#path-a-local-mcp-for-claude-code) | [Path B](#path-b-self-hosted-remote-connector) | [Path C](#path-c-channel-audit-skill) |

**MCP vs. skill, in one sentence each:** the *MCP server* is the connection that fetches your data
(it needs your Google sign-in). The *skill* is a set of instructions that tells Claude how to turn
that data into a good audit. It has no access to anything by itself.

Most people should do **Path A**, then optionally add **Path C**.

---

## Path A: Local MCP for Claude Code

### What `setup` does and doesn't do

`youtube-channel-mcp setup` walks you through importing your Google credentials, signing in,
checking the connection and registering the server with Claude Code. It **can't** create the
Google Cloud project or OAuth client for you; that part happens in your browser (step A2). It
does **not** deploy anything.

### A1. Install

You need [Node.js](https://nodejs.org) **22 or newer** (check with `node -v`),
[Git](https://git-scm.com), and [Claude Code](https://code.claude.com).

**Windows (PowerShell):**

```powershell
git clone https://github.com/Jebrz/youtube-channel-mcp.git
```

```powershell
cd youtube-channel-mcp
```

```powershell
npm install
```

```powershell
npm link
```

**macOS / Linux:**

```bash
git clone https://github.com/Jebrz/youtube-channel-mcp.git
cd youtube-channel-mcp
npm install
npm link
```

`npm install` also builds the project. `npm link` makes the `youtube-channel-mcp` command available
everywhere. If `npm link` fails, or PowerShell says "running scripts is disabled", you can run every
command below from the project folder as `node dist/index.js <command>` instead, for example
`node dist/index.js setup`. See [Troubleshooting](docs/TROUBLESHOOTING.md).

> **npm:** the package is **not published on npm yet**. Once it is, `npm install -g youtube-channel-mcp`
> will replace the clone-and-link steps. Until then, install from the repository as shown.

### A2. Create Google credentials (in your browser, once)

Follow **[docs/GOOGLE_CLOUD_SETUP.md](docs/GOOGLE_CLOUD_SETUP.md)**. In short:

1. Create a Google Cloud project.
2. Enable **YouTube Data API v3** and **YouTube Analytics API**.
3. Configure Google Auth Platform (the OAuth consent screen): user type **External**, and add your
   Google account as a **test user**.
4. Create an OAuth client of type **Desktop app** and **download its JSON**.

Keep that JSON private. It identifies your Google Cloud project. Don't put it in the project
folder, email it or commit it. `setup` copies it into a private configuration folder for you.

### A3. Run setup

**Windows (PowerShell):**

```powershell
youtube-channel-mcp setup
```

**macOS / Linux:**

```bash
youtube-channel-mcp setup
```

It will:

1. check your Node.js version;
2. ask whether you're setting up local use or a hosted connector;
3. look for an existing setup (it never prints credential contents);
4. ask for the path of the JSON you downloaded. You can drag the file into the window, paste a
   quoted path, or use `~` / `%USERPROFILE%`. Paths with spaces are fine;
5. check it's a **Desktop app** client and save it to your configuration folder with owner-only
   permissions. It asks before replacing an existing file and keeps a backup;
6. remind you of the Google Cloud steps it can't check;
7. open Google sign-in. Choose the account, or **Brand Account**, that owns the channel and **tick
   every checkbox**. Google shows an "unverified app" screen for your own project; that's expected;
8. show the connected channel's name and ID;
9. run a live check (two read-only requests);
10. offer to register the server with Claude Code. It asks before changing an existing registration.
    If Claude Code isn't installed, it prints the exact command to run later.

Configuration folder (outside the repository):

| OS | Folder |
| --- | --- |
| Windows | `%APPDATA%\youtube-channel-mcp\` |
| macOS / Linux | `~/.config/youtube-channel-mcp/` |

Set `YT_MCP_CONFIG_DIR` to use a different folder.

Illustrative output (made-up channel, abbreviated):

```text
── Step 7: Check the connection
1/2 Reading channel via YouTube Data API (channels.list mine=true)...
    OK: "Example Channel" (UCxxxxxxxxxxxxxxxxxxxxxx), 87 videos.
2/2 Running a YouTube Analytics query (views, last 7 days)...
    OK: 2026-10-29..2026-11-04: views=1234, minutesWatched=2345
Connected channel: Example Channel (ID UCxxxxxxxxxxxxxxxxxxxxxx)
```

### A4. Use it in Claude Code

Restart Claude Code, type `/mcp` and check that **youtube-channel** is connected. Then ask, for
example:

- "Give me an overview of my YouTube channel."
- "How did the last 28 days compare with the previous 28 days?"
- "Which traffic sources brought the most views last week?"
- "Show the audience retention for my most-watched video this month."

If you skipped registration, register manually (use the path that `setup` or `doctor` prints):

**Windows (PowerShell):**

```powershell
claude mcp add youtube-channel --scope user -- node "C:\path\to\youtube-channel-mcp\dist\index.js" serve
```

**macOS / Linux:**

```bash
claude mcp add youtube-channel --scope user -- node "/path/to/youtube-channel-mcp/dist/index.js" serve
```

### A5. When it doesn't connect

```bash
youtube-channel-mcp doctor
```

`doctor` checks Node.js, the configuration folder, your OAuth client, your sign-in and recorded
permissions, and Claude Code's registration. Each result is **OK**, **WARN** or **ACTION**, with a
plain-language next step. It makes **no network requests** unless you add `--live`:

```bash
youtube-channel-mcp doctor --live
```

`--live` makes two read-only Google requests. It tells you whether the problem is an expired sign-in,
missing permissions, a disabled API, quota, the network, or an account without a channel. It never
prints tokens, client secrets or file contents. It exits with code 1 when something needs action.
See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for the table of known problems.

### A6. Disconnect and revoke access

| To… | Run / do |
| --- | --- |
| Revoke Google access and delete the saved sign-in | `youtube-channel-mcp logout` |
| Remove the server from Claude Code | `claude mcp remove youtube-channel` |
| Remove the OAuth client file too | Delete `client_secret.json` from the configuration folder |
| Check from Google's side | [myaccount.google.com/permissions](https://myaccount.google.com/permissions) → remove the app |

---

## Path B: Self-hosted remote connector

A published claude.ai **artifact** can't use a server that only runs on your computer. Anthropic's
artifact documentation says local MCP servers configured in Claude Code can't be called by published
pages. To get live data in claude.ai or in artifacts, you deploy the remote connector
(`youtube-channel-mcp serve-http`) and add it in claude.ai as a custom connector.

- **Prerequisites:** Path A working on your computer, a Google Cloud account for hosting, and
  comfort with `gcloud` or a similar tool.
- **What you're responsible for:** the server, its passphrase, its costs (often within free tiers;
  check current pricing), and keeping it updated.
- **One channel per deployment:** each deployment serves exactly one channel
  (`YT_MCP_EXPECTED_CHANNEL_ID`). It refuses to return data if the Google sign-in belongs to a
  different channel. It's not a multi-customer service; see
  [docs/ROADMAP_HOSTED_SERVICE.md](docs/ROADMAP_HOSTED_SERVICE.md).
- **Security:** OAuth 2.1 with PKCE, an owner passphrase (stored only as a hash; entered with
  hidden input), redirect allowlist, rotating refresh tokens, Host-header checks, read-only tools.
  The public `/health` endpoint returns only `{"ok":true}`.

Guide: **[docs/HOSTED_SETUP.md](docs/HOSTED_SETUP.md)**. Live dashboards:
[docs/ARTIFACT_DASHBOARD.md](docs/ARTIFACT_DASHBOARD.md) and the page sources in `artifacts/`.

---

## Path C: Channel-audit skill

`skills/youtube-channel-audit/` teaches Claude to produce a consistent audit:

1. channel and reporting dates,
2. data sources, fetch times and limitations,
3. performance summary with valid comparisons,
4. top-video and traffic-source findings,
5. three prioritized actions tied to evidence,
6. experiments with measurable success criteria.

It uses `get_dashboard` first to avoid redundant requests, keeps lifetime totals separate from
period metrics, and doesn't invent numbers or promise growth. **It needs a working connector from
Path A or B.** Without one it explains how to connect instead of guessing.

**Install for Claude Code (all projects):**

**Windows (PowerShell),** from the project folder:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills" | Out-Null
```

```powershell
Copy-Item -Recurse -Force skills\youtube-channel-audit "$env:USERPROFILE\.claude\skills\"
```

**macOS / Linux,** from the project folder:

```bash
mkdir -p ~/.claude/skills && cp -R skills/youtube-channel-audit ~/.claude/skills/
```

Restart Claude Code and ask "Audit my YouTube channel for the last 28 days." For claude.ai,
installation details, a fictional sample report and what has been tested, see
[skills/youtube-channel-audit/README.md](skills/youtube-channel-audit/README.md).

---

## Things worth knowing

### Lifetime totals vs. a selected period

- **Lifetime totals** (`get_channel_overview`): all-time public views, subscriber count and video
  count from the YouTube Data API. YouTube rounds the subscriber count down to three significant
  figures.
- **Period analytics** (`get_channel_analytics`, `get_dashboard`): views, watch time, subscribers
  gained/lost and so on for a date range, from the YouTube Analytics API.

They come from different systems and can differ slightly. Don't compare one with the other.

### Dates, lag and comparisons

YouTube Analytics data is usually 2–3 days behind, and its days are in Pacific Time. Presets such as
`last_28_days` end 2 days before today (UTC). Comparisons use the previous period of equal length
or the same dates last year. When the comparison value is 0 or missing, no % change is shown.
Missing data is reported as unavailable, never as zero.

### What is cached and what "Refresh" does

| Where | Cached | "Refresh" |
| --- | --- | --- |
| `get_dashboard` (local and hosted) | In server memory for 15 minutes per period and comparison; cleared when the server restarts | `force_refresh: true` re-queries Google, at most once per 60 seconds; sooner requests get the cached copy, marked `throttled` |
| Other tools | Not cached by the server | Every call queries Google |
| Published artifact | claude.ai also caches results per viewer | The page's Refresh button forces a refresh (same limits). It refreshes every 15 minutes only while open and visible. **Nothing refreshes while it's closed** |
| Saved sign-in | Access token reused until expiry, then refreshed automatically | `youtube-channel-mcp auth` signs in again |

### Local vs. published artifact

| Works locally (Path A) | Needs the hosted connector (Path B) |
| --- | --- |
| Claude Code chats, the `check`/`doctor` commands, the audit skill in Claude Code | claude.ai chats, published artifacts and dashboards, other people's access (they'd need your passphrase) |

### Google "Testing" mode: sign-ins expire after 7 days

Google's documentation says: an External project whose publishing status is **Testing** "is issued
a refresh token expiring in 7 days" (unless only basic profile scopes are requested, which isn't the
case here). Testing is also limited to 100 listed test users. So in Testing mode you'll need to run
`youtube-channel-mcp auth` again about once a week. `doctor --live` reports it as "sign-in expired or
revoked".

For longer-lived use, set the publishing status to **In production**
(Google Auth Platform → Audience → *Publish app*). Per Google's documentation, an app that remains
unverified then shows an "unverified app" screen and is limited to 100 new users. Whether your use
needs Google's verification is Google's decision; read
[Manage App Audience](https://support.google.com/cloud/answer/15549945),
[Unverified apps](https://support.google.com/cloud/answer/7454865) and
[OAuth 2.0: refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
before switching. Refresh tokens can also stop working if you revoke access, don't use them for six
months, or create more than 100 sign-ins for the same client.

### Limitations

- Your own channels only. Analytics only work for the channel you signed in as.
- One sign-in per configuration folder. For a second channel, use a separate `YT_MCP_CONFIG_DIR` and
  register a second server name.
- Read-only: no uploads, edits or comment replies. Comments, captions, content-owner (CMS) reports
  and the bulk Reporting API are out of scope.
- Revenue metrics need `youtube-channel-mcp auth --monetary` and a channel in the YouTube Partner
  Program.
- Quota: the YouTube Data API allows 10,000 units a day per Google Cloud project by default; each
  call here costs 1–2 units.

---

## Tools

| Tool | What it returns |
| --- | --- |
| `get_channel_overview` | Profile and lifetime counts |
| `list_videos` | Your uploads, newest first, paginated |
| `get_video_details` | Metadata and public counts for up to 50 video IDs |
| `get_channel_analytics` | Channel report: summary, daily, monthly, country, traffic source, device type, playback location, demographics, sharing service, top videos; with date presets or custom dates and comparisons |
| `get_video_analytics` | The same for one video, plus audience retention |
| `get_dashboard` | Cached bundle: overview, period summary with comparison, daily series, top videos, traffic sources. Each section has its own status and fetch time |

Report and metric combinations: [docs/ANALYTICS.md](docs/ANALYTICS.md).

## Commands

| Command | Purpose |
| --- | --- |
| `youtube-channel-mcp setup` | Guided local setup (`--manual` for headless sign-in, `--port <n>`) |
| `youtube-channel-mcp doctor` | Diagnostics, offline (`--live` adds two Google requests; `--no-claude`, `--json`) |
| `youtube-channel-mcp auth` | Sign in again (`--monetary`, `--manual`, `--port <n>`) |
| `youtube-channel-mcp check` | Live check: read channel + one analytics query |
| `youtube-channel-mcp status` | Paths and sign-in status as JSON, no secrets |
| `youtube-channel-mcp logout` | Revoke and delete the saved sign-in |
| `youtube-channel-mcp serve` | Run the MCP server on stdio (Claude Code starts this for you) |
| `youtube-channel-mcp serve-http` | Run the hosted connector (Path B) |
| `youtube-channel-mcp hash-password` | Create the hosted connector's passphrase hash (hidden input; `--stdin` for pipes) |
| `youtube-channel-mcp env-export` | Print credentials as environment variables for hosting. **Prints secrets**; use only as documented |

---

## What has been verified

| Level | What | Evidence |
| --- | --- | --- |
| Mocked automated tests | All CLI, auth, setup, doctor, tools, dashboard cache and remote-auth logic | `npm test` runs offline against mocked Google responses; a guard fails any real network request. A CI workflow for Windows and Linux (Node 22/24/26) is configured but hasn't run on GitHub yet |
| Local integration checks | Built CLI in a pseudo-terminal: hidden passphrase input, Ctrl+C, `setup` importing a file from a path with spaces, `doctor` exit codes; `claude mcp add/get/remove` against a throwaway home folder | Run by the maintainer during development |
| Real Google requests | Request path, error mapping and token refresh against Google's real endpoints with invalid credentials; the owner's own sign-in and `check` on their machine | Reported by the owner |
| Reports verified with an authorized channel | `get_channel_overview`, `list_videos`, `get_dashboard` (7 and 28 days, previous period), channel `country` and `device_type`, video `summary`, `daily` and `retention`. Proof artifact showed live data through the hosted connector | Real requests through the hosted connector, Nov 2026 |
| **Not yet verified with a real channel** | `monthly`, `playback_location`, `demographics`, `sharing_service`, standalone `top_videos`, `get_video_details`, `previous_year` and custom comparisons, 90-day presets, revenue metrics, per-video country/device/traffic, the full live dashboard artifact, `setup` and `doctor --live` with a real Google account | — |

## Development

```bash
npm install
npm test            # mocked tests only, offline
npm run typecheck
npm run build
npm run pack:check  # inspect what would be published
```

[docs/TESTING.md](docs/TESTING.md) covers the testing levels; [docs/RELEASING.md](docs/RELEASING.md)
the release checklist. Project layout:

```
src/        server, tools, auth, analytics, dashboard cache, remote connector, cli/ (setup, doctor)
test/       offline tests with mocked Google responses
skills/     the channel-audit skill
artifacts/  claude.ai artifact page sources (no data)
docs/       setup, hosting, troubleshooting, roadmap
```

## Security and privacy

Read-only scopes. Credentials stay in your configuration folder (or your host's secret manager),
outside the repository and never in artifact code. Logs and diagnostics redact secrets. Details:
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Not affiliated with or endorsed by Google or YouTube. YouTube is a trademark of
Google LLC. Use of the APIs is subject to the
[YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service).
