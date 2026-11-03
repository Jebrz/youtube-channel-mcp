# Live analytics inside Claude artifacts

How a claude.ai artifact gets live YouTube data from this project, what refreshes when, and what the
limits are.

## Data path

```
artifact page (claude.ai)
  └─ claude.use("mcp") → callTool / watchTool("YouTube Channel", …)   ← runs as the VIEWER, viewer consents once
       └─ claude.ai connector "YouTube Channel" (OAuth token held by claude.ai, never by the page)
            └─ https://<your host>/mcp   (youtube-channel-mcp serve-http)
                 ├─ OAuth check → channel-isolation check → server cache
                 └─ YouTube Data API v3 / YouTube Analytics API (Google token kept on the server)
```

The page never sees a Google or Claude token. claude.ai holds the connector token, and your server
holds the Google token.

## What runs locally vs hosted

| | Local (`serve`, stdio) | Hosted (`serve-http`) |
| --- | --- | --- |
| Claude Code on your computer | ✓ | ✓ (as a remote server, optional) |
| Published claude.ai artifact | ✗ (docs: published pages can't call local servers) | ✓ |
| Credentials location | `~/.config/youtube-channel-mcp/` | Host secret manager |
| Setup guide | [README](../README.md#setup-for-beginners) | [HOSTED_SETUP.md](HOSTED_SETUP.md) |

The local connector, and any local browser dashboard you run with it, keeps working unchanged.

## Refresh behaviour

> Status: the server side (`get_dashboard`, caching, stale handling) is implemented and tested. The
> published artifact so far is only the **one-metric connection proof**. The full dashboard page is
> built once that proof shows real data through your hosted connector. The table below describes
> the intended behaviour.

| Situation | What happens |
| --- | --- |
| You open the artifact | The page shows any cached copy immediately, then fetches fresh data. The server answers from its cache if the last fetch is under 15 minutes old. |
| You press **Refresh** | A forced call. The server re-queries Google, unless the previous attempt was under 60 s ago, in which case it returns the cached copy marked `throttled`. |
| Hourly auto-refresh (optional toggle) | While the page is open and visible, `watchTool` polls once an hour. It pauses while the tab is hidden and catches up when you return. |
| **The artifact is closed** | **Nothing refreshes.** There is no background job. Data only updates when someone opens the page. To get updates while closed, you'd need a separate scheduled backend, for example a Cloud Scheduler job that calls the server and stores snapshots. That's not part of this project. |
| A refresh fails | The last successful data stays on screen, marked **stale**, with the error and its last-fetched time. Missing values stay "unavailable" and are never replaced by zero. |

### Caching layers

1. **Server cache** (`DashboardService`): one entry per period and comparison. TTL is 15 min
   (`YT_MCP_DASHBOARD_TTL_SECONDS`), forced refreshes are limited to once per 60 s, there's a 60 s
   backoff after a total failure, and concurrent requests are coalesced. Every section keeps its own
   last-good copy.
2. **Viewer cache** (claude.ai shell): `watchTool` results are cached per viewer and per artifact, and
   replayed instantly when the page is reopened.

## Quota per refresh

`get_dashboard` makes 2 Data API calls of 1 unit each: `channels.list`, and `videos.list` for the
top-video titles. The channel-isolation check adds at most 1 unit per 10 minutes. It also runs 7
YouTube Analytics queries: summary ×2, daily ×2, top videos ×1, traffic sources ×2. Against the
default 10,000-unit Data API quota, hourly refreshes are negligible.

## Troubleshooting

| Code on the page | Meaning | Fix |
| --- | --- | --- |
| `server_not_connected` | No claude.ai connector named exactly **YouTube Channel** on the viewing account | Add it ([HOSTED_SETUP step 5](HOSTED_SETUP.md#5-add-the-connector-in-claudeai)). Check the spelling. |
| `needs_reauth` | The connector's sign-in expired or was revoked | Reconnect it in claude.ai and enter your passphrase. |
| `not_in_manifest` / `approval_required` | You declined the page's access request | Reload the page and choose Allow. |
| `server_unavailable` | Server asleep, crashed or unreachable | Wait and retry. Check Cloud Run logs and `/healthz`. |
| `tool_error` + `CHANNEL_MISMATCH` | The server's Google token is for a different channel | Re-export credentials from the right account, or fix `YT_MCP_EXPECTED_CHANNEL_ID`. |
| `tool_error` + `AUTH_REQUIRED` | Google refused the server's refresh token (Testing-mode 7-day expiry, revoked, password change) | Run `auth` locally, then `env-export`, update the secret and redeploy. |
| `tool_error` + `QUOTA_EXCEEDED` | YouTube API quota used up | Wait for the reset at midnight Pacific Time. Stale data stays visible meanwhile. |

## Privacy

- Artifacts start private. A connector-backed page shows live data only to signed-in viewers who
  have their **own** "YouTube Channel" connector. People you share the page with see empty live
  sections unless they connect to your server, and that needs your passphrase.
- Don't embed analytics in artifact HTML. A page with embedded data, like the earlier
  "AI Recess Analytics Snapshot", shows those numbers to anyone it's shared with. That snapshot is
  currently shared with anyone who has the link.
- Generated reports and exported data stay out of the repository (`.gitignore` covers `reports/`,
  `exports/` and `*.analytics.json`).
