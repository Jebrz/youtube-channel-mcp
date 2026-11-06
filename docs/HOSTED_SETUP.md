# Hosted setup: remote connector for live Claude artifacts

Use this setup if you want a **published Claude artifact** (a dashboard page on claude.ai) to fetch
your YouTube analytics live. For Claude Code on your own computer, the
[local setup in the README](../README.md#setup-for-beginners) is enough and nothing here is needed.

## Why a hosted server is required

Anthropic's documentation for artifacts says:

> "Only connectors from your claude.ai account qualify … Local MCP servers you configure in Claude Code,
> such as servers from .mcp.json, can supply data while Claude builds the page, but the published page
> can't call them."
> ([Share session output as artifacts](https://code.claude.com/docs/en/artifacts#pull-live-data-with-mcp-connectors))

A claude.ai connector is a **remote MCP server**. It must be **reachable over the public internet from
Anthropic's IP range** (`160.79.104.0/21`)
([custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)).
Your local stdio server can't satisfy that, and that's why the earlier artifact failed with
`server_not_connected`.

`youtube-channel-mcp serve-http` is that remote server. It reuses the same read-only Google API code
as the local connector.

## How access is protected

| Layer | What it does |
| --- | --- |
| OAuth 2.1 (required) | Claude must sign in before any tool runs. Unauthenticated requests get `401` with a `resource_metadata` pointer, as Claude's connector docs require. |
| Owner passphrase | The sign-in page approves access only with your passphrase. Only its scrypt hash is configured on the server. Wrong guesses are rate-limited: 5 per IP and 20 in total per 15 minutes. |
| Redirect allowlist | Dynamic Client Registration accepts only Claude's callback `https://claude.ai/api/mcp/auth_callback` and Claude Code's loopback `http://localhost:*/callback` / `http://127.0.0.1:*/callback`. |
| PKCE S256, single-use codes | Authorization codes expire after 60 s and can be used only once. |
| Short-lived, audience-bound tokens | Access tokens last 1 h and are valid only for `<public URL>/mcp`. Refresh tokens last 30 days and are **rotated** on every use. If an old refresh token is used again, the whole session is revoked. |
| Hashed token storage | The state file stores SHA-256 hashes of tokens, never the tokens themselves. |
| Channel isolation | `YT_MCP_EXPECTED_CHANNEL_ID` is required. Before tools run, the server checks that the Google token belongs to that channel. If it doesn't, every tool returns `CHANNEL_MISMATCH` and no analytics are fetched. One deployment serves exactly one channel. |
| Host-header check | Requests addressed to any host other than your public host are refused (DNS-rebinding protection). |
| Read-only | Only the read-only tools exist. Google scopes stay `youtube.readonly` and `yt-analytics.readonly`. |
| No secrets in Git or in the image | Google credentials and the passphrase hash are runtime secrets. The Dockerfile and `.dockerignore` exclude credential files. |

This deployment is **not** your existing local service exposed through a tunnel. It's a separate
process that requires authentication on every MCP request.

## Recommended host: Google Cloud Run

You already have a Google Cloud project for the YouTube APIs, and Cloud Run provides HTTPS
automatically. Run these commands on your own computer, in a terminal with the
[gcloud CLI](https://cloud.google.com/sdk/docs/install) signed in to that project.

### 0. Prerequisites

1. The local setup works: `youtube-channel-mcp check` succeeds on your computer.
2. **Set your OAuth consent screen to "In production".** In *Testing* status, Google expires refresh
   tokens after 7 days, which would break the hosted connector every week. See
   [GOOGLE_CLOUD_SETUP.md](GOOGLE_CLOUD_SETUP.md#refresh-tokens-that-expire-after-7-days). Then run
   `youtube-channel-mcp auth` again so you get a long-lived refresh token.
3. Find your channel ID, the `channelId` in `get_channel_overview`. It looks like `UC` followed by
   22 more characters.

### 1. Create the secrets

```bash
youtube-channel-mcp env-export      # prints YT_MCP_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN (secrets!)
youtube-channel-mcp hash-password   # passphrase of 12+ characters, typed twice with hidden input; prints a scrypt hash
```

`hash-password` hides what you type and refuses to run where hidden input isn't possible. In that case
pipe the passphrase explicitly with `--stdin`.

Store each value in Secret Manager. Paste each value when prompted, then clear your terminal.

```bash
gcloud services enable run.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

```bash
for NAME in yt-mcp-client-id yt-mcp-client-secret yt-mcp-refresh-token yt-mcp-owner-password-hash; do
  read -r -s -p "$NAME: " VALUE; echo
  printf %s "$VALUE" | gcloud secrets create "$NAME" --data-file=-
done
```

### 2. Create a bucket for OAuth state (keeps you signed in across restarts)

```bash
gcloud storage buckets create gs://YOUR-PROJECT-yt-mcp-state --location=us-central1 --uniform-bucket-level-access
```

If you skip this, set `YT_MCP_STATE_FILE=memory`. Each new container instance then forgets Claude's
sign-in, and you'll have to reconnect the connector more often.

### 3. Deploy

From the repository folder. The first deploy uses a placeholder URL, which you fix in step 4.

```bash
gcloud run deploy yt-mcp --source . --region us-central1 \
  --allow-unauthenticated \
  --max-instances 1 --execution-environment gen2 \
  --add-volume name=state,type=cloud-storage,bucket=YOUR-PROJECT-yt-mcp-state \
  --add-volume-mount volume=state,mount-path=/state \
  --set-env-vars YT_MCP_PUBLIC_URL=https://placeholder.invalid,YT_MCP_EXPECTED_CHANNEL_ID=UCxxxxxxxxxxxxxxxxxxxxxx,YT_MCP_TRUST_PROXY=1,YT_MCP_STATE_FILE=/state/remote-oauth-state.json \
  --set-secrets YT_MCP_CLIENT_ID=yt-mcp-client-id:latest,YT_MCP_CLIENT_SECRET=yt-mcp-client-secret:latest,YT_MCP_REFRESH_TOKEN=yt-mcp-refresh-token:latest,YT_MCP_OWNER_PASSWORD_HASH=yt-mcp-owner-password-hash:latest
```

- `--allow-unauthenticated` only means Google's front door doesn't demand a *Google* login, which
  Claude couldn't provide. The server itself still requires OAuth on `/mcp`.
- `--max-instances 1` keeps the cache, rate limits and OAuth state in one place.
- The Cloud Run service account needs **Secret Manager Secret Accessor** on the four secrets and
  **Storage Object User** on the bucket. `gcloud` will tell you if something is missing.

### 4. Set the real public URL

The health endpoint is `/health`. It returns only `{"ok":true}`, with no channel, credential or
analytics information. `/healthz` still works as an alias, but Cloud Run reserves some paths ending
in "z" ([known issues](https://cloud.google.com/run/docs/known-issues)), so don't rely on it there.

```bash
URL=$(gcloud run services describe yt-mcp --region us-central1 --format='value(status.url)')
gcloud run services update yt-mcp --region us-central1 --update-env-vars YT_MCP_PUBLIC_URL=$URL
curl -s $URL/health                        # -> {"ok":true}
curl -s -o /dev/null -w "%{http_code}\n" -X POST $URL/mcp   # -> 401 (auth required: correct)
echo "Connector URL: $URL/mcp"
```

### 5. Add the connector in claude.ai

1. On claude.ai, open **Customize → Connectors → + Add → Add custom connector**.
2. **Name: `YouTube Channel`**. Use exactly this name: the artifact looks the connector up by its
   display name.
3. **URL:** `https://…run.app/mcp`, the value printed in step 4.
4. Authentication: leave the detected OAuth settings, and choose **Register automatically** or
   **Use Claude's published identity**. Don't add request headers.
5. Click **Add**, then **Connect**. Your server's sign-in page opens. Check that it names
   `claude.ai` as the redirect, enter your passphrase, and click **Approve**.

### 6. Run the proof

Open the **YouTube Connector Proof** artifact on claude.ai and allow it to use **YouTube Channel**
when asked. It should show your channel's lifetime views. **Fetch again** must succeed a second
time, and the fetch log shows each call.

If it fails, the page names the error code. See [ARTIFACT_DASHBOARD.md](ARTIFACT_DASHBOARD.md#troubleshooting).

## Other hosts

Any host works if it gives you **public HTTPS**, a **single instance**, ideally **persistent disk**
for `YT_MCP_STATE_FILE`, and secret environment variables. Use the provided `Dockerfile`. Set
`YT_MCP_HTTP_HOST=0.0.0.0`, `PORT`, `YT_MCP_TRUST_PROXY=1` behind a proxy, and the variables in
[`examples/remote.env.example`](../examples/remote.env.example).

- **A VPS or home server with a reverse proxy (Caddy/nginx) or a named Cloudflare Tunnel** also
  works. The process is the authenticated `serve-http` server, not your local stdio connector. The
  machine must stay on.
- Optionally restrict inbound traffic to Anthropic's range `160.79.104.0/21` plus your own IP. Your
  own IP needs access because the sign-in page opens in your browser.

## Settings reference

Numeric settings are validated at start-up; invalid values stop the server with a clear message.

| Variable | Allowed | Default |
| --- | --- | --- |
| `PORT` | 1–65535 | 8787 (Cloud Run sets 8080) |
| `YT_MCP_DASHBOARD_TTL_SECONDS` | 60–86400 | 900 |
| `YT_MCP_TRUST_PROXY` | `true`, `false`, or 0–10 (number of proxy hops) | `false` |
| `YT_MCP_EXPECTED_CHANNEL_ID` | `UC` + 22 characters | required |

Check a configuration without starting the server: set the same variables and run
`youtube-channel-mcp doctor` (the "Hosted connector settings" line).

## Costs (estimates, check current pricing)

| Item | Typical cost for one person |
| --- | --- |
| Cloud Run, scale-to-zero, `max-instances 1` | Usually within the monthly free tier: about 2 million requests and generous vCPU/memory-seconds. Hourly dashboard refreshes are a few hundred requests a month. |
| Secret Manager, 4 secrets | A small number of active secret versions are free. Beyond that it's cents per version per month. |
| Cloud Storage bucket for state | Kilobytes of data, effectively free. |
| Cloud Build / Artifact Registry for `--source` deploys | Small. Free tiers usually cover occasional deploys. Old images can be deleted. |
| YouTube Data / Analytics API | Free within quota. One dashboard refresh uses about 3 Data API units and 7 Analytics queries, and the server cache allows at most one refresh per 15 min per period. |

With scale-to-zero, the first request after idle has a cold start of a few seconds. Claude allows 10 s
for OAuth endpoints. If you see intermittent sign-in timeouts, set `--min-instances 1`, which
**is billed continuously**.

## Operations

- **Rotate the passphrase:** `hash-password`, then add a new version of `yt-mcp-owner-password-hash`
  and redeploy. Existing tokens keep working until they expire. To force everyone out, also delete
  the state file.
- **Revoke Claude's access:** remove the connector in claude.ai, or delete the state file and restart.
- **Revoke Google access:** https://myaccount.google.com/permissions
- **Logs:** Cloud Run logs carry redacted messages only. Tokens, codes and secrets are masked.
