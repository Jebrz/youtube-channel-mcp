# youtube-channel-mcp

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server that lets
[Claude Code](https://code.claude.com) read **your own** YouTube channel's content and analytics
through Google's official APIs:

- **YouTube Data API v3**: channel profile, uploaded videos, video metadata and public counts
- **YouTube Analytics API v2**: views, watch time, traffic sources, demographics, retention, and more

It runs locally on your computer, signs in with Google OAuth, and never changes anything on your
channel. The first version has no write operations at all.

> Status: v0.1, early. Mocked tests pass. The live connection path has been tested against Google's
> real endpoints, but only with invalid credentials. Nobody has run it against a real channel yet.
> Please run `youtube-channel-mcp check` after setup and report problems.

---

## What you can ask Claude

- "Give me an overview of my YouTube channel."
- "List my 20 most recent videos with their view counts."
- "How did my channel do in the last 28 days compared with the previous 28 days?"
- "Which traffic sources brought the most views last month vs the same month last year?"
- "Show the audience retention curve for video `dQw4w9WgXcQ`."
- "What were my top 10 videos by watch time this year?"

## Tools

| Tool | What it does | API & quota |
| --- | --- | --- |
| `get_channel_overview` | Channel title, description, handle, creation date, lifetime views/subscribers/video count | Data API `channels.list`, 1 unit |
| `list_videos` | Uploaded videos, newest first, with duration and public counts. Paginated with `page_token`. | Data API `playlistItems.list` + `videos.list`, 1–2 units/page |
| `get_video_details` | Full metadata and public counts for 1–50 video IDs; reports IDs that returned nothing | Data API `videos.list`, 1 unit per 50 IDs, plus 1 unit for `channels.list` |
| `get_channel_analytics` | Channel-wide report: `summary`, `daily`, `monthly`, `country`, `traffic_source`, `device_type`, `playback_location`, `demographics`, `sharing_service`, `top_videos` | Analytics API `reports.query` |
| `get_video_analytics` | The same reports for one video, plus `retention` (audience retention curve) | Analytics API `reports.query` |
| `get_dashboard` | One cached bundle for dashboards: overview, summary + comparison, daily series, top videos, traffic sources. Each section reports `ok`/`stale`/`error` with its own fetch time, and the last good data is kept on failure. | Both APIs. Server cache of 15 min, forced refreshes limited to once per 60 s |

Both analytics tools accept:

- **Date range**: a `preset` (`last_7_days`, `last_28_days` (default), `last_90_days`, `last_365_days`, `this_month`, `last_month`, `this_year`, `last_year`) or a custom `start_date`/`end_date` (`YYYY-MM-DD`).
- **Comparison period**: `compare` = `previous_period`, `previous_year`, or `custom` (with `compare_start_date`/`compare_end_date`). Summary and keyed reports (such as countries or traffic sources) come back with per-metric changes (absolute and %). Daily and monthly reports come back as two side-by-side series.
- **Metrics**: optional. Each report has defaults and a list of allowed metrics, which is checked before any API call. See [docs/ANALYTICS.md](docs/ANALYTICS.md).

### No made-up data

When Google returns nothing, the server says so. Missing rows stay empty. A missing value is
`null`, never `0`. Hidden subscriber counts are `null`, and changes against a missing period are
`null`. Every analytics result carries a `notes` array explaining gaps, plus the exact `query`
that was sent.

---

## Setup for beginners

You need about 15 minutes. There are three parts: **(A)** create Google credentials once,
**(B)** install this server, and **(C)** connect it to Claude Code.

### Prerequisites

- [Node.js](https://nodejs.org) 20 or newer (`node -v` to check)
- [Claude Code](https://code.claude.com) installed
- The Google account that owns (or manages) your YouTube channel

### A. Google Cloud setup (manual, one time)

This part has to be done by you in the Google Cloud Console. Follow
**[docs/GOOGLE_CLOUD_SETUP.md](docs/GOOGLE_CLOUD_SETUP.md)**. In short:

1. Create a Google Cloud project.
2. Enable **YouTube Data API v3** and **YouTube Analytics API**.
3. Configure the OAuth consent screen (External, add yourself as a test user).
4. Create an OAuth client ID of type **Desktop app** and download its JSON.

### B. Install and sign in

```bash
git clone https://github.com/jebrz/youtube-channel-mcp.git
cd youtube-channel-mcp
npm install          # also builds into dist/
npm link             # makes the `youtube-channel-mcp` command available
```

Put the downloaded OAuth JSON **outside the repository**, in the config folder:

| OS | Config folder |
| --- | --- |
| macOS / Linux | `~/.config/youtube-channel-mcp/` |
| Windows | `%APPDATA%\youtube-channel-mcp\` |

```bash
mkdir -p ~/.config/youtube-channel-mcp
mv ~/Downloads/client_secret_*.json ~/.config/youtube-channel-mcp/client_secret.json
chmod 600 ~/.config/youtube-channel-mcp/client_secret.json
```

Sign in. A URL is printed; open it, choose the account or **brand channel** that owns the channel,
and tick every permission checkbox:

```bash
youtube-channel-mcp auth
```

Add `--monetary` if you're in the YouTube Partner Program and want revenue metrics.

Then run the **live check**. This is the smallest end-to-end test: it reads your channel and runs
one analytics query.

```bash
youtube-channel-mcp check
```

Expected output:

```
1/2 Reading channel via YouTube Data API (channels.list mine=true)...
    OK: "Your Channel" (UC...), 42 videos.
2/2 Running a YouTube Analytics query (views, last 7 days)...
    OK: 2026-10-26..2026-11-01: views=1234, minutesWatched=5678
Live connection works.
```

### C. Connect to Claude Code

```bash
claude mcp add youtube-channel --scope user -- youtube-channel-mcp serve
```

Or copy [`examples/mcp.json.example`](examples/mcp.json.example) into your project as `.mcp.json`.
Restart Claude Code, run `/mcp` to confirm **youtube-channel** is connected, and ask
"Give me an overview of my YouTube channel."

### Other commands

```bash
youtube-channel-mcp status       # where config lives, whether you're signed in, granted scopes (no secrets shown)
youtube-channel-mcp logout       # revoke the token at Google and delete it locally
youtube-channel-mcp auth --manual  # headless machine: paste the redirected URL instead of using a local server
```

---

## Live dashboards inside Claude artifacts (hosted mode)

A published claude.ai artifact **can't** call this server when it runs locally over stdio. Anthropic's
docs state that local MCP servers configured in Claude Code can't be called by published pages. To
get live data inside an artifact, deploy the authenticated remote connector
(`youtube-channel-mcp serve-http`) and add it in claude.ai as a custom connector named
**YouTube Channel**:

- [docs/HOSTED_SETUP.md](docs/HOSTED_SETUP.md): deployment (Cloud Run), OAuth + owner passphrase,
  channel isolation, costs
- [docs/ARTIFACT_DASHBOARD.md](docs/ARTIFACT_DASHBOARD.md): how artifact refresh, caching and stale
  data work, and troubleshooting
- [artifacts/connector-proof.html](artifacts/connector-proof.html): the one-metric proof page

The local setup above is unchanged and doesn't need any of this.

## Security and privacy

- **Read-only by design.** The server requests only `youtube.readonly` and
  `yt-analytics.readonly`, plus `yt-analytics-monetary.readonly` if you pass `--monetary`. It calls
  only `list`/`query` GET endpoints. Every tool is annotated `readOnlyHint: true`.
- **Credentials live outside the repo.** By default they go in `~/.config/youtube-channel-mcp/`.
  The folder is created with mode `700` and the token file with mode `600`. If the token path
  is inside a git working tree, the server prints a warning. `.gitignore` excludes
  `client_secret*.json`, `token*.json`, `.env*` and export folders as a second safeguard.
- **Secrets are redacted from logs.** Logs go to stderr only, because stdout carries the MCP
  protocol. Access tokens (`ya29.`), refresh tokens (`1//`), client secrets (`GOCSPX-`), API keys,
  bearer headers and OAuth form fields are masked. Tool error messages are redacted too.
- **Your data goes only to Google and to your Claude Code session.** The server has no telemetry
  and no third-party calls. Analytics results you ask about are sent to the model as tool output.
- **PKCE + state** are used for sign-in. The callback server listens only on `127.0.0.1`.
- **Revoke any time:** run `youtube-channel-mcp logout`, or visit https://myaccount.google.com/permissions.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Limitations

- **Your own channel only.** Analytics work only for the channel you signed in as.
  `get_video_details` can read public metadata for other channels' videos and labels them
  `ownedByAuthorizedChannel: false`.
- **Data latency.** YouTube Analytics data is usually 2–3 days behind, and its days are in
  Pacific Time. Date presets end 2 days before today (UTC).
- **Quota.** The Data API's default allowance is 10,000 units/day per Google Cloud project, and
  each call here costs 1–2 units. The Analytics API has its own quota. When you hit a limit, the
  error is `QUOTA_EXCEEDED` with a hint. Short rate limits are retried automatically; a used-up
  daily quota is not.
- **Testing-mode tokens expire after 7 days.** If your OAuth consent screen is in *Testing*,
  Google expires refresh tokens after 7 days and you'll need to run `auth` again. See
  [docs/GOOGLE_CLOUD_SETUP.md](docs/GOOGLE_CLOUD_SETUP.md#refresh-tokens-that-expire-after-7-days).
- **Demographics** are often empty for small channels or short ranges, because YouTube withholds them.
- **Monetary metrics** need `auth --monetary` and a channel in the YouTube Partner Program.
- **Content-owner (CMS) reports**, the bulk Reporting API, comments, captions and any write actions
  are out of scope for v0.1.
- **Claude Code cloud sessions** need extra setup and carry extra risk. See
  [docs/CLOUD_SESSIONS.md](docs/CLOUD_SESSIONS.md).

## Development

```bash
npm install
npm test            # mocked unit tests only, no network, no credentials
npm run typecheck
npm run build
npm run live-check  # LIVE: calls Google with your saved credentials (opt-in)
```

[docs/TESTING.md](docs/TESTING.md) explains how mocked tests and live validation are kept apart.

Project layout:

```
src/
  index.ts              CLI entry (serve | serve-http | auth | status | check | logout | env-export | hash-password)
  server.ts             MCP tool registration (zod input schemas, read-only annotations)
  tools.ts              Tool implementations
  auth/                 OAuth sign-in (PKCE loopback), token refresh, credential storage
  google/               Authenticated HTTP client (retries, error mapping) + Data API wrapper
  analytics/            Report catalog (verified combinations), date ranges, comparisons, query runner
  dashboard/            Cached dashboard aggregation (per-section last-good data, throttling)
  remote/               Remote connector: OAuth 2.1 server (owner passphrase), HTTP app, channel guard
  errors.ts, redact.ts  Typed errors and secret redaction
artifacts/              Artifact page sources (no data embedded)
test/                   Vitest suites with mocked Google responses
docs/                   Setup, analytics reference, cloud sessions, testing
```

## License

[MIT](LICENSE)

This project is not affiliated with or endorsed by Google or YouTube. YouTube is a trademark of
Google LLC. Your use of the APIs is subject to the
[YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service).
