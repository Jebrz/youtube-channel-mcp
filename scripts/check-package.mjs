#!/usr/bin/env node
// Release check: inspect what `npm pack` would publish, without publishing.
// Fails if the tarball contains anything that looks like credentials, tokens,
// private analytics, caches or development-only files, or misses files the
// documented workflows need.
import { execFileSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const raw = execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", shell: process.platform === "win32" });
const [info] = JSON.parse(raw);
const files = info.files.map((f) => f.path.replace(/\\/g, "/"));

const forbidden = [
  [/(^|\/)client_secret(?!\.example)[^/]*\.json$/i, "OAuth client secret"],
  [/(^|\/)credentials[^/]*\.json$/i, "credentials file"],
  [/(^|\/)token[^/]*\.json$/i, "token file"],
  [/oauth-state[^/]*\.json$/i, "remote OAuth state"],
  [/(^|\/)\.env(\.|$)/, "environment file"],
  [/\.analytics\.json$|(^|\/)(exports|reports)\//i, "exported analytics"],
  [/(^|\/)(test|src|coverage|node_modules|\.github)\//, "development-only folder"],
  [/\.map$/, "source map"],
  [/(^|\/)[^/]*-workspace\//, "skill eval workspace"],
];
const required = ["dist/index.js", "README.md", "LICENSE", "skills/youtube-channel-audit/SKILL.md", "docs/GOOGLE_CLOUD_SETUP.md", "examples/client_secret.example.json"];

const problems = [];
for (const f of files) for (const [re, why] of forbidden) if (re.test(f)) problems.push(`must not ship ${why}: ${f}`);
for (const r of required) if (!files.includes(r)) problems.push(`missing required file: ${r}`);

console.log(`${info.name}@${info.version}: ${files.length} files, ${(info.size / 1024).toFixed(1)} kB packed`);
for (const f of files) console.log(`  ${f}`);
if (problems.length) {
  console.error(`\nPackage check FAILED:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("\nPackage check passed.");
