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
4. Move the file **outside any git repository**:

   ```bash
   mkdir -p ~/.config/youtube-channel-mcp
   mv ~/Downloads/client_secret_*.json ~/.config/youtube-channel-mcp/client_secret.json
   chmod 600 ~/.config/youtube-channel-mcp/client_secret.json
   ```

   On Windows, use `%APPDATA%\youtube-channel-mcp\client_secret.json`. You can also point
   `YT_MCP_CLIENT_SECRET_FILE` at the file wherever you keep it.

> For Desktop apps, Google says the "client secret" isn't truly secret, but treat it as private
> anyway. Never commit it.

## 5. Sign in

```bash
youtube-channel-mcp auth            # add --monetary for revenue metrics (YPP channels only)
youtube-channel-mcp check
```

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

Run `youtube-channel-mcp auth` again. To avoid the weekly sign-in, you can set the publishing
status to **In production**. That has trade-offs:

- Your app stays *unverified*. The "unverified app" warning remains and the app is capped at 100
  users, which doesn't matter for personal use.
- Google's policies for sensitive scopes still apply. Read Google's
  [OAuth app verification help](https://support.google.com/cloud/answer/13463073) before choosing this.

Refresh tokens can also stop working if you change your Google password (for some scopes), revoke
access, or leave them unused for 6 months.

## Quota

Default YouTube Data API quota is **10,000 units per day** per project, and it resets at midnight
Pacific Time. This server's Data API calls cost 1 unit each (it never uses the 100-unit
`search.list`). You can see usage under **APIs & Services → YouTube Data API v3 → Quotas**. The
YouTube Analytics API has its own separate quota.
