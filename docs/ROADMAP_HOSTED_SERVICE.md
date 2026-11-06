# Roadmap: a hosted service for many customers

**Status: roadmap only. Nothing here is implemented.** Today each deployment of
`youtube-channel-mcp serve-http` serves exactly **one** channel for **one** owner, guarded by
`YT_MCP_EXPECTED_CHANNEL_ID` and an owner passphrase. That design is intentional and stays in place
until everything below exists. Customer support must not be added by removing the channel guard or
by sharing one Google token across users.

## Two different sign-ins

A multi-customer service needs two separate authorizations. Mixing them up is the most common
design mistake:

| | 1. Customer sign-in to *our app* | 2. Customer's authorization to read *their YouTube data* |
| --- | --- | --- |
| Question it answers | "Who is this person, and which of our accounts do they own?" | "May this app read this specific channel's analytics?" |
| Mechanism | Our identity provider (for example Google Sign-In / OIDC, email+password with MFA, or SSO) issuing *our* session | Google OAuth with `youtube.readonly` and `yt-analytics.readonly`, issuing a refresh token **per customer, per Google account** |
| Who issues tokens | Our app | Google |
| Revocable by | Us (session) and the customer (log out) | The customer at myaccount.google.com/permissions, or us via Google's revoke endpoint |

Signing in to our app must never imply YouTube access. YouTube access is granted, shown and revoked
separately, channel by channel.

Claude's connector OAuth is a third layer. The MCP endpoint issues tokens to Claude on behalf of
*our* customer account, as `serve-http` does today for one owner. Those tokens map to a customer
account, which maps to that customer's authorized channels.

## Work required

### Accounts and authentication
- Customer accounts with verified email, MFA option, session management, account recovery.
- Replace the single owner passphrase with per-customer login on the OAuth consent page used by
  Claude connectors.
- Admin tooling with audited, least-privilege access. Staff never see tokens.

### Per-customer Google authorization
- A "Connect YouTube channel" flow per customer (web redirect client, not the Desktop client used
  locally), storing which Google account and which channel IDs were authorized.
- Brand Accounts: one Google login may manage several channels. Record exactly which channel the
  customer chose, and enforce it on every request (the current channel guard, generalized).
- Handle partial consent (unticked scopes), revocation and `invalid_grant` per customer, with clear
  "reconnect" states.

### Credential storage and access control
- Refresh tokens encrypted at rest with a KMS-managed key (envelope encryption), per-customer
  records, never logged, never returned by any API.
- Every data access checks: authenticated customer → owns connection → connection authorizes this
  channel. Deny by default. Tests for cross-tenant access (customer A can't read B).

### Cache isolation
- Cache keys include **customer ID + channel ID + full query** (report, metrics, dates, comparison).
  The current in-memory cache is keyed only by period and is safe solely because there is one channel.
- Invalidate a customer's cache entries on disconnect or channel change.
- Optionally a shared cache (Redis or similar) with the same keying and TTLs.

### Transactional state
- Move OAuth state (clients, codes, access/refresh token hashes, refresh-token families, pending
  consents) and customer/connection records from the JSON file to a transactional database
  (for example Postgres/Cloud SQL or Firestore in transactions).
- Atomic refresh-token rotation and reuse detection across instances: single-use codes, `usedAt`
  updates and family revocation must be transactions.

### Concurrency and multiple instances
- Today the docs require `--max-instances 1`. Multi-instance needs shared state (above),
  distributed rate limiting for the consent page and token endpoint, and coalescing of concurrent
  refreshes of the same Google token, so two instances don't refresh at once.
- Idempotent background jobs if scheduled reports are added.

### Disconnect, revocation, retention, deletion
- Customer-facing disconnect: revoke the Google token at Google, delete stored tokens, purge cache,
  invalidate Claude connector tokens.
- Account deletion: remove all customer data within a stated period; keep only what law requires
  (for example billing records).
- Retention policy for cached analytics and logs. Logs stay redacted.
- Honour Google's API Services User Data Policy and the YouTube API Services Terms (including their
  data storage and deletion requirements) and publish a privacy policy that matches.

### Google consent, verification and quota
- A public multi-user app needs Google's **OAuth app verification** for these scopes, a verified
  domain, privacy policy and terms pages, and likely a YouTube API Services compliance audit.
- Quota is per Google Cloud project, shared by all customers. Request quota increases, track usage
  per customer, and apply per-customer limits so one customer can't exhaust everyone's quota.

### Hosting, costs and operations
- Costs grow with customers: database, KMS, multiple instances, logging, backups, a domain and TLS.
  Free tiers no longer cover it.
- Operational duties: on-call for outages, security patching, dependency updates, incident response
  and breach notification, backups and restore tests, monitoring of auth failures and quota.
- Support: customers will need help with consent, Brand Accounts and reconnecting.

## Suggested order

1. Database-backed OAuth state, still single-tenant (removes the single-instance limit).
2. Customer accounts and per-customer Google connections, still **one channel per customer**,
   with tenant-isolation tests.
3. Cache and quota isolation per customer.
4. Disconnect, deletion and retention tooling.
5. Google verification and compliance review before onboarding anyone beyond test users.
