# Google Cloud setup (manual steps)

You have to do these steps yourself in a browser. They create the OAuth client that lets this
server ask *you* for read-only access to your channel. Nothing here costs money. The YouTube
APIs are free within their quota.

> Google renames Cloud Console menus from time to time. If a label doesn't match exactly, look for
> the closest equivalent. The menu paths below are from late 2026.

## 1. Create a project

1. Go to <https://console.cloud.google.com/>.
2. Use the project picker at the top and choose **New project**.
3. Name it something like `youtube-channel-mcp`, then click **Create** and select it.

## 2. Enable the two APIs

In **APIs & Services → Library**, search for and **Enable** each of these:

- **YouTube Data API v3**
- **YouTube Analytics API**

(You do *not* need the "YouTube Reporting API".)

If you skip this, tools fail with `CONFIG_ERROR: The required API is not enabled...`.

## 3. Configure the OAuth consent screen

Open **APIs & Services → OAuth consent screen**. Newer consoles call it **Google Auth Platform**.

1. **User type: External.** Choose Internal only if you use Google Workspace and the channel
   belongs to that Workspace.
2. Fill in the app name (e.g. `youtube-channel-mcp (personal)`), your support email and your
   developer contact email.
3. **Scopes / Data access:** add these. You can also skip this step, because the app requests
   them at sign-in anyway.
   - `https://www.googleapis.com/auth/youtube.readonly`
   - `https://www.googleapis.com/auth/yt-analytics.readonly`
   - optionally `https://www.googleapis.com/auth/yt-analytics-monetary.readonly`
4. **Test users / Audience:** add the Google account that owns or manages your channel.
   While the app is in *Testing*, only listed test users can sign in.

## 4. Create the OAuth client

1. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**. Newer consoles
   call it **Google Auth Platform → Clients → Create client**.
2. **Application type: Desktop app.** This is important: a *Web application* client will not
   work, because sign-in uses a loopback redirect to `http://127.0.0.1:<port>`.
3. Click **Create**, then **Download JSON**.
4. Import it with `youtube-channel-mcp setup`. Give it the downloaded file's path when asked; you
   can drag the file into the terminal window. Setup checks that it's a Desktop app client and
   copies it into your configuration folder, outside any git repository, with owner-only
   permissions:

   | OS | Saved to |
   | --- | --- |
   | Windows | `%APPDATA%\youtube-channel-mcp\client_secret.json` |
   | macOS / Linux | `~/.config/youtube-channel-mcp/client_secret.json` |

   You can then delete the copy in your Downloads folder. Advanced: set `YT_MCP_CLIENT_SECRET_FILE`
   to keep the file somewhere else.

> For Desktop apps, Google says the "client secret" isn't truly secret, but treat it as private
> anyway. Never commit it.

## 5. Sign in

`youtube-channel-mcp setup` continues straight into Google sign-in and a live check. To sign in
again later (for example after the 7-day Testing expiry, or to switch channels):

```bash
youtube-channel-mcp auth
```

Then confirm it works:

```bash
youtube-channel-mcp doctor --live
```

Add `--monetary` to `auth` only if you want revenue metrics (YouTube Partner Program channels only).

On the consent screen:

- You'll see **"Google hasn't verified this app"**. That's expected for your own unverified
  project. Click **Continue**. You're the developer and the only user.
- If your channel is a **Brand Account**, choose the brand channel on the account picker, not
  your personal account.
- **Tick every checkbox.** Google lets you deselect individual permissions, and if you do, some
  tools will fail. `auth` warns you when a scope is missing.

## Refresh tokens that expire after 7 days

While the consent screen's **publishing status is "Testing"**, Google expires refresh tokens after
**7 days**. When that happens, tools return:

```
AUTH_REQUIRED: Google rejected the saved refresh token (invalid_grant) ...
```

`youtube-channel-mcp doctor --live` reports this as **Sign-in expired or revoked**. Run
`youtube-channel-mcp auth` again.

Google's wording ([OAuth 2.0: refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)):
an External project with publishing status "Testing" "is issued a refresh token expiring in 7 days,
unless the only OAuth scopes requested are a subset of name, email address, and user profile". The
YouTube scopes used here aren't in that subset, so the 7-day limit applies.

To avoid the weekly sign-in, set the publishing status to **In production** (Google Auth Platform →
Audience → **Publish app**), then sign in again. Per Google's
[Manage App Audience](https://support.google.com/cloud/answer/15549945) and
[Unverified apps](https://support.google.com/cloud/answer/7454865) pages:

- A production app is available to any Google account, not just listed test users.
- If it remains unverified, users see an "unverified app" screen before the consent screen, and the
  app is limited to 100 new users until verified.
- Whether your use requires Google's verification is Google's decision; read those pages before
  switching. This project can't check your project's publishing status.

Refresh tokens also stop working if you revoke access, if they go unused for six months, or if you
create more than 100 sign-ins for the same OAuth client (the oldest is then invalidated).

## Quota

Default YouTube Data API quota is **10,000 units per day** per project, and it resets at midnight
Pacific Time. This server's Data API calls cost 1 unit each (it never uses the 100-unit
`search.list`). You can see usage under **APIs & Services → YouTube Data API v3 → Quotas**. The
YouTube Analytics API has its own separate quota.
