# Testing: mocked tests vs live validation

There are two completely separate kinds of testing.

## 1. Mocked unit tests (`npm test`)

- Location: `test/*.test.ts`, run by Vitest (`vitest.config.ts` includes only `test/**/*.test.ts`).
- **No network and no credentials.** Each test injects a fake `fetch` (`test/helpers.ts`) that
  returns hand-written responses shaped like real Google API responses. An unexpected request
  throws `Unmocked request`, so a test can't reach Google by accident.
- Safe to run in CI and in Claude Code cloud sessions.

Coverage:

| File | Covers |
| --- | --- |
| `auth.test.ts` | Token caching, refresh, concurrent refresh coalescing, `invalid_grant` (expired/revoked) → `AUTH_REQUIRED`, `invalid_client` → `CONFIG_ERROR`, PKCE consent URL, redirect/state validation, code exchange, missing scopes, client JSON loading (Desktop vs Web), token file mode `600` |
| `client.test.ts` | Bearer header, 401 → refresh → retry, `quotaExceeded` (not retried), `rateLimitExceeded`/5xx/429 (retried), "query is not supported" → `METRIC_UNAVAILABLE`, API disabled → `CONFIG_ERROR`, insufficient scopes → `AUTH_REQUIRED` |
| `tools.test.ts` | All five tools: pagination tokens, multi-page traversal, empty and missing uploads playlist, hidden subscriber counts, not-found video IDs, ownership flags, summary and keyed comparisons, empty analytics (no invented zeros), monetary scope check, monthly alignment, top-videos sort/limit and titles, retention ordering, custom comparison |
| `server.test.ts` | Real MCP client ↔ server over the SDK's in-memory transport: tool list, read-only annotations, JSON results, `isError` payloads with secrets redacted, input-schema validation |
| `dates.test.ts` | Presets, custom range validation, previous-period / previous-year arithmetic (including leap years and whole months) |
| `redact.test.ts` | Token/secret patterns, nested objects, logger writes only to stderr |

## 2. Live validation (`npm run live-check`): opt-in and manual

`youtube-channel-mcp check` (or `npm run live-check` after building) talks to the real Google APIs
with **your** saved credentials:

1. `channels.list?mine=true` (YouTube Data API, 1 quota unit)
2. `reports.query` for `views,estimatedMinutesWatched` over the last 7 days (YouTube Analytics API)

It prints only the channel title/ID and the two numbers. Nothing secret is printed. Run it:

- after first setup,
- after changing scopes (`auth --monetary`),
- when tools report `AUTH_REQUIRED` or `CONFIG_ERROR`, to narrow down the cause.

Live checks are **never** part of `npm test` or CI, because they need a real Google account and
private channel data.

### Manual live checklist for a release

With a real channel, in Claude Code:

- [ ] `get_channel_overview` matches YouTube Studio (subscriber count is rounded by YouTube)
- [ ] `list_videos` with `max_results: 5`, then `page_token`, covers the next 5 videos
- [ ] `get_video_details` with one of your IDs and one bogus ID: the bogus ID shows up in `notFound`
- [ ] `get_channel_analytics` `summary` with `compare: previous_period`: totals are close to Studio's "Last 28 days" (Studio may include more recent provisional data)
- [ ] `get_channel_analytics` `top_videos`, `traffic_source`, `demographics` (may be empty for small channels)
- [ ] `get_video_analytics` `retention` for a video with views
- [ ] With an expired token (or after revoking at myaccount.google.com/permissions), tools return `AUTH_REQUIRED`

### What has been validated so far (v0.1)

- Mocked suite: all tests pass.
- Live, without a real account: from a cloud container, the request path was exercised against
  Google's real endpoints with deliberately invalid credentials. A fake access token got HTTP 401
  from the Data API and was correctly reported as `AUTH_REQUIRED`. A fake client got
  `invalid_client` from the token endpoint and was correctly reported as `CONFIG_ERROR`.
- **Not yet validated against a real channel.** That requires the manual Google Cloud setup and
  sign-in described in the README.
