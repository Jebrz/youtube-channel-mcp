# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Security → Report a vulnerability**
(private advisory) on this repository. Don't open a public issue. Never include real tokens,
client secrets or channel data in a report. Redact them first.

## Design summary

- Read-only OAuth scopes only (`youtube.readonly`, `yt-analytics.readonly`, optional
  `yt-analytics-monetary.readonly`). No write endpoints are called.
- OAuth "installed app" flow with PKCE (S256) and a `state` check. The callback listens on
  `127.0.0.1` only.
- Credentials are stored outside the repository (`~/.config/youtube-channel-mcp/`, directory mode
  `700`, token mode `600`). The server warns if the token path is inside a git working tree.
- Logs go to stderr and pass through a redactor that masks tokens, secrets, API keys and OAuth form
  fields. Tool error payloads are redacted too.
- `env-export` is the only command that prints secrets, and only when you run it explicitly.
- `setup` and `doctor` never print credential contents: client IDs are masked, tokens and client
  secrets are never shown, and the Claude Code registration check doesn't display the
  registration's environment variables. `doctor` makes no network requests unless `--live` is given.
- `hash-password` reads the passphrase with hidden input and restores the terminal on Ctrl+C. It
  refuses to fall back to visible input; piping requires the explicit `--stdin` flag.
- The hosted connector's `/health` endpoint is unauthenticated and returns only `{"ok":true}`.

If you think a token leaked, revoke it at <https://myaccount.google.com/permissions>, run
`youtube-channel-mcp logout`, and consider resetting the OAuth client secret in Google Cloud
Console.
