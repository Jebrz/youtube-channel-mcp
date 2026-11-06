# Testing and verification levels

"It works" can mean very different things. This project keeps four levels apart. The README's
[What has been verified](../README.md#what-has-been-verified) table says which features have reached
which level.

| Level | Needs Google account? | Network? | Where |
| --- | --- | --- | --- |
| 1. Mocked automated tests | No | No (blocked) | `npm test`, CI |
| 2. Local integration checks | No | No | Built CLI on a developer machine |
| 3. Real Google requests | Yes (or deliberately invalid credentials) | Yes | `doctor --live`, `check`, `setup` |
| 4. Reports verified with an authorized channel | Yes, the channel owner | Yes | Real tool calls, results inspected |

## 1. Mocked automated tests (`npm test`)

- Files: `test/*.test.ts`, run by Vitest. `test/networkGuard.ts` is loaded first and **fails any
  `fetch` to a non-loopback host**, so a test can't reach Google by accident. Google is simulated
  with hand-written responses (`test/helpers.ts`).
- The only real sockets are the in-process HTTP servers that `remote.test.ts` starts on `127.0.0.1`.
- Safe in CI. The workflow (`.github/workflows/ci.yml`) is set up for Ubuntu and Windows on Node 22, 24
  and 26, but it hasn't run on GitHub yet.

| File | Covers |
| --- | --- |
| `cli.test.ts` | Offline guard; path normalization (Windows spaces, quotes, PowerShell drag-and-drop, `%USERPROFILE%`, macOS escaped spaces, `~`); OAuth client inspection (Desktop/Web/service account/invalid JSON/BOM); import with owner-only permissions, overwrite protection and backups; yes/no and choice parsing; hidden input (no echo, Backspace, arrow keys, Ctrl+C restoring the terminal, refusal when no TTY); `--port` validation; Claude Code registration parsing (Environment section never kept), env pass-through without secrets, quoting; `doctor` offline/OK/broken-file/missing-scope/Testing-expiry/moved-registration cases and `--live` classification of API disabled, missing permissions, expired sign-in, quota, network, analytics refused, channel mismatch, no channel, with secret-redaction checks; `setup` fresh install from a path with spaces, Ctrl+C, pause, invalid-then-valid file, preserving an existing setup and registration, asking before replacing a registration, declining overwrite, no Claude Code, failed sign-in, hosted mode |
| `auth.test.ts` | Token caching, refresh, concurrent refresh, `invalid_grant`, `invalid_client`, PKCE URL, redirect/state validation, code exchange, missing scopes, client JSON loading, token file mode `600` |
| `client.test.ts` | Bearer header, 401 → refresh → retry, quota vs rate limit, 5xx/429 retries, "query not supported", API disabled, insufficient scopes |
| `tools.test.ts` | All analytics/data tools: pagination, empty results without invented zeros, comparisons, monetary scope gate, monthly alignment, top videos, retention |
| `dashboard.test.ts` | Server cache TTL, coalescing, per-period keys, throttled force refresh, stale retention on failure, backoff, recovery |
| `remote.test.ts` | Remote connector auth boundaries over real local HTTP: 401 + metadata, Host check, `/health` and `/healthz` (no auth, no private data, served before the Host check), redirect allowlist, passphrase/lockout/deny, resource binding, PKCE, single-use codes, hashed tokens, refresh rotation/reuse detection, expiry, audience, channel isolation, config validation including numeric settings |
| `server.test.ts` | MCP tool list and read-only annotations, JSON results, redacted errors, input validation, version matches `package.json` |
| `dates.test.ts`, `redact.test.ts` | Date presets/comparisons; secret redaction and stderr-only logging |

## 2. Local integration checks

Done by hand on the built CLI (`npm run build`), without Google:

- `hash-password` in a pseudo-terminal: passphrase not echoed; Ctrl+C exits with code 130.
- `setup` in a pseudo-terminal: imports a client JSON from a quoted path containing spaces, saves it
  with mode `600` in a `700` folder, continues when sign-in is declined, prints both registration
  commands, and exits cleanly (130) on Ctrl+C.
- `doctor` on an empty configuration folder: ACTION items and exit code 1.
- `claude mcp add` (with `-e YT_MCP_CONFIG_DIR=…` and a path containing spaces), `claude mcp get`
  and `claude mcp remove` against a throwaway home folder, to confirm the command format `setup` uses.
- `npm run pack:check` to inspect the package file list.

Repeat on Windows before a release. These checks have so far been run on Linux only.

## 3. Real Google requests

```bash
youtube-channel-mcp doctor --live
```

Makes two read-only requests (channel + one analytics query) with your saved sign-in and reports the
result in plain language. `youtube-channel-mcp check` does the same with less explanation. Never part
of `npm test` or CI.

## 4. Reports verified with an authorized channel

A report counts as verified only when a real request for *that report* returned data for a channel
the signer owns, and the result was inspected. A working channel overview or one analytics query
doesn't mean every report works. The README lists which reports have reached this level.

### Manual checklist for a release

With a real channel, in Claude Code:

- [ ] `youtube-channel-mcp setup` on a clean machine (Windows and macOS/Linux), including Brand
      Account selection
- [ ] `youtube-channel-mcp doctor --live` is all OK
- [ ] `get_channel_overview` matches YouTube Studio (subscriber count is rounded by YouTube)
- [ ] `list_videos` pages correctly with `page_token`
- [ ] `get_dashboard` 7/28/90 days with `previous_period` and `previous_year`
- [ ] `get_channel_analytics`: `monthly`, `country`, `device_type`, `playback_location`,
      `demographics` (may be empty), `sharing_service`, `top_videos`
- [ ] `get_video_analytics`: `summary`, `daily`, `retention`, `traffic_source`
- [ ] After revoking access at myaccount.google.com/permissions, `doctor --live` reports
      "Sign-in expired or revoked"
- [ ] The audit skill produces the six-section report
