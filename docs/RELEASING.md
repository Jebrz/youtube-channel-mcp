# Releasing

The package is **not published to npm yet**. The name `youtube-channel-mcp` was unregistered when
last checked (Nov 2026); check again before the first release. These steps describe how a release
*would* be made. Don't run `npm publish` until the checklist passes.

## How people install today

From the repository (documented in the README):

```bash
git clone https://github.com/Jebrz/youtube-channel-mcp.git
cd youtube-channel-mcp
npm install
npm link
```

## Intended npm path (after publishing)

```bash
npm install -g youtube-channel-mcp
youtube-channel-mcp setup
```

The package ships `dist/` (compiled JavaScript, no source maps), `docs/`, `examples/`, `skills/`,
`artifacts/`, `README.md`, `LICENSE` and `SECURITY.md`. When installed globally, `setup` registers
`node <global install path>/dist/index.js serve` with Claude Code.

## Checklist

1. `git status` is clean and you're on the release branch.
2. `npm ci`
3. `npm run typecheck`
4. `npm test` (offline; must pass on Windows and Linux in CI)
5. `npm run build`
6. `npm run pack:check`, which inspects the `npm pack` file list. It fails on credentials, tokens,
   OAuth state, `.env` files, analytics exports, source folders, source maps or skill-eval
   workspaces, and checks that required files are present. Read the printed file list yourself too.
7. Bump the version in `package.json` **and** `SERVER_VERSION` in `src/server.ts` (a test checks they
   match). Update the README "What has been verified" table if anything new was verified with a
   real channel.
8. Try the tarball in a clean prefix:

   ```bash
   npm pack
   npm install -g ./youtube-channel-mcp-<version>.tgz --prefix "$(mktemp -d)"
   ```

   Then run `<prefix>/bin/youtube-channel-mcp --help` (Windows: `<prefix>\youtube-channel-mcp.cmd --help`).
9. Tag the release (`git tag v<version>`), push the tag, and write release notes listing
   compatibility changes.
10. Only then: `npm publish` (requires an npm account with access; not done by maintainers' tooling
    automatically).

## Compatibility notes for 0.2.0

- Node.js requirement raised to **22.12+** (`engines`). Node 20 reached end of life on 2026-04-30
  and the test tooling no longer supports it. The server itself still starts on Node 20, and `doctor`
  warns.
- New commands: `setup`, `doctor`. All existing commands, MCP tool names, configuration paths,
  environment variables and the token/client file formats are unchanged. Tokens saved by `auth` now
  also record `obtained_at` (optional; older files still load).
- Hosted connector: `/health` added (documented); `/healthz` kept as an alias. Numeric settings
  (`PORT`, `YT_MCP_DASHBOARD_TTL_SECONDS`, `YT_MCP_TRUST_PROXY`) are now validated and invalid values
  stop the server with a clear message instead of being silently misread.
  `YT_MCP_DASHBOARD_TTL_SECONDS` must be 60–86400.
- `hash-password` now uses hidden input and asks twice; it refuses to run when hidden input isn't
  available unless you pass `--stdin` explicitly. The hash format (`scrypt$…`) is unchanged.
