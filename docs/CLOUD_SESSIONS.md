# Running in Claude Code cloud sessions

The recommended setup is **local**: Claude Code on your computer starts this server over stdio,
and the token stays in `~/.config/youtube-channel-mcp/`. Cloud sessions
([claude.ai/code](https://claude.ai/code)) work, but with the limitations and risks below.

## Limitations

| Area | Limitation |
| --- | --- |
| **Browser sign-in** | `auth` redirects your browser to `http://127.0.0.1:<port>` *on the machine running the server*. In a cloud container, your browser can't reach that address, so the normal sign-in can't finish. `auth --manual` needs someone to type into the server's terminal, and cloud sessions don't give you that terminal. |
| **Ephemeral storage** | The container is thrown away after inactivity. A token file written there disappears, and you'd have to sign in again each time. |
| **Network policy** | The environment's network policy must allow `oauth2.googleapis.com`, `www.googleapis.com` and `youtubeanalytics.googleapis.com`. The sign-in host `accounts.google.com` is only needed for `auth`. When this project was built, those API hosts were reachable from a cloud session, but `developers.google.com` (documentation) was blocked. Your environment's policy may differ. |
| **Build step** | `dist/` isn't committed. The environment's setup script has to run `npm ci` (which also builds) before the MCP server can start. |
| **Secret exposure** | In a cloud session, environment variables are visible to every process in the container, including commands Claude runs. Anyone who can use that environment can use your channel's read access. |

## Option A (recommended): use it locally

Keep the YouTube connector on your own computer and use cloud sessions for other work.

## Option B: supply a refresh token through environment variables

This uses the server's headless mode. Tokens are kept **in memory only** and never written to
disk.

1. **On your own computer**, complete the normal setup and sign in:

   ```bash
   youtube-channel-mcp auth
   youtube-channel-mcp check
   ```

2. Print the values. This is the *only* command that prints secrets:

   ```bash
   youtube-channel-mcp env-export
   ```

   It prints `YT_MCP_CLIENT_ID`, `YT_MCP_CLIENT_SECRET`, `YT_MCP_REFRESH_TOKEN` and
   `YT_MCP_SCOPES`.

3. In the cloud environment's settings (the environment menu in the session title bar → **Edit**),
   add those values as **environment variables**. Never paste them into a chat message, an issue,
   or a committed file. For network access, setup scripts and secrets, see the
   [cloud environments documentation](https://code.claude.com/docs/en/cloud-environments).

4. Add a setup script that installs and builds this project, and register the server. For
   example, commit an `.mcp.json` to the repository you work in:

   ```json
   {
     "mcpServers": {
       "youtube-channel": {
         "command": "node",
         "args": ["./youtube-channel-mcp/dist/index.js", "serve"]
       }
     }
   }
   ```

   The server reads the `YT_MCP_*` variables from its environment. Don't put secret values in
   `.mcp.json`.

5. Start a **new** session. New sessions pick up environment changes.

### Risks of Option B (read before using it)

- The refresh token gives **long-lived read access** to your channel data and analytics until you
  revoke it. It can't modify the channel, but it can read private analytics.
- Claude, or any command run in that environment, can read the variable (e.g. `env`).
- To revoke it: go to <https://myaccount.google.com/permissions> → remove the app. Or, on your
  computer, run `youtube-channel-mcp logout`, which revokes the same grant.
- If your OAuth app is in **Testing** status, the token stops working after 7 days. See
  [GOOGLE_CLOUD_SETUP.md](GOOGLE_CLOUD_SETUP.md#refresh-tokens-that-expire-after-7-days).

## Not supported

- A hosted or remote (HTTP/SSE) version of this server. v0.1 is stdio-only.
- Signing in from inside the cloud session.
