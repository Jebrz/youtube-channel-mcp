# Agensi listing draft: YouTube CSV Channel Audit

**Status: draft, not submitted. Not marketplace-ready yet.** See [Readiness](#readiness) for
what's still open. Nothing here has been published.

Submission file: `release/youtube-csv-audit-0.1.0.zip`, built by
`python3 scripts/build-csv-skill-zip.py`.

---

## Listing copy

**Title:** YouTube CSV Channel Audit

**Short description (one line):** Upload your YouTube Studio export and get a channel audit with
traceable numbers and three experiments to run next. No Google sign-in.

**Description:**

Export your analytics from YouTube Studio (Analytics → Advanced mode → Export current view → CSV)
and give the ZIP to your agent. The skill runs a small, readable Python script on the file. Every
figure in the audit is copied or calculated from your export, and the calculation log names the
file, row and column it came from.

You get:

- Headline numbers for the period: views, engaged views, watch time, impressions, CTR, average
  view duration, average percentage viewed, net subscribers
- What's working and where performance leaks: packaging (impressions vs CTR), retention by video
  length, engaged share, concentration on a few videos, subscriber conversion
- Your publishing pattern and which videos are still too new to judge
- **Three experiments** tied to your own numbers, each with a success threshold and the exact
  export column to check next time
- Honest data notes: blank cells stay blank, period figures aren't lifetime figures, the Total row
  is reconciled against the video rows, and view-counting changes are flagged

Works with English and Malay YouTube Studio exports.

**Who it's for:** small and mid-size creators, channel managers and agencies who want a
structured review without connecting accounts or installing tools.

**What it doesn't do:** no live data, no API access, no revenue analysis (revenue columns are
ignored), no traffic-source or audience breakdowns yet, no Studio languages other than English and
Malay yet.

**Privacy:** the script makes no network connections and doesn't install anything. It reads only
the files you give it. It never extracts archives to disk, and writes two output files only where
you tell it to.

**Required capabilities:** code execution with **Python 3.10+** (standard library only), and the
ability to read an uploaded ZIP or CSV file. It doesn't work in a chat window without code
execution.

**Tags:** youtube, youtube-analytics, youtube-studio, creator, content-audit, csv, analytics,
malay

**Price:** to be decided by the owner. Agensi's creator guide says most single-purpose skills sit
at $5–15.

---

## Readiness

Requirements checked on 2026-11-06 against these Agensi pages:
[security scan](https://www.agensi.io/learn/how-agensi-security-scan-works),
[creator checklist](https://www.agensi.io/learn/skill-md-creator-checklist),
[selling guide](https://www.agensi.io/learn/how-to-sell-skills-on-agensi),
[MCP / buyer FAQ](https://www.agensi.io/mcp),
[SKILL.md format](https://www.agensi.io/learn/skill-md-format-reference).

### Execution requirement (the important one)

Agensi serves skills through its MCP connector rather than as downloads. The buyer FAQ says:
"Scripts must be piped directly into an interpreter, never saved to disk", and buyers are told
"Never write any part of a skill to disk."

| What that needs | Status |
| --- | --- |
| Script runs from stdin (`python3 - <inputs>`), with no `__file__` and no sibling files | Done and tested: piped output is byte-identical to a direct run, on synthetic data and on the real Malay export |
| Single self-contained file, standard library only | Done; an automated test checks the imports |
| A mistyped piped copy fails safely rather than giving wrong numbers | Done: every run self-tests first and exits with code 4 on failure (tested with a deliberately damaged copy) |
| SKILL.md tells the agent how to pipe it | Done |
| Works end to end through the real Agensi connector | **Not tested.** No Agensi account was used. |
| Script size suits piping | **Risk:** the script is about 62 KB. The agent must reproduce it exactly in a command. The self-test catches damage, but long scripts make that more likely and use more tokens. Not measured. |

### 8-point security scan

| Check | Status |
| --- | --- |
| Prompt injection | SKILL.md contains no override instructions. It tells the agent to treat titles and file contents as data. Not scanned by Agensi. |
| Data exfiltration / env harvesting | Script reads only the given paths and no environment variables, and has no network code (tested). |
| Dangerous commands | No deletes, no installs, no system changes. Writes only to `--out` (tested). |
| Hardcoded secrets | None. The build fails on key/token patterns. |
| Obfuscation | Readable, commented code, no base64 or minification. |
| Network access | None. URLs appear only in reference docs as citations. |
| ZIP structure | One top-level folder with SKILL.md at its root. No symlinks, binaries, `.DS_Store` or tests. Script mode 755. Built reproducibly. |
| SKILL.md validity | `name` matches the folder; description is 585 characters; body has instructions. |

### Quality checklist

| Item | Status |
| --- | --- |
| Trigger-based description | Done |
| Defined output format | Done (`references/audit-template.md`) |
| At least one reference file or example | Done (5 references, 1 synthetic sample report) |
| README in the skill folder | Done |
| Tested in at least two agents | **Not done.** The script was run directly. An agent loading the skill was only simulated in this build session; it wasn't tested in Claude Code, claude.ai or a second agent. |
| Someone else tested it | **Not done** |

### Before submitting

1. Install the ZIP in Claude Code and on claude.ai (with code execution) and run a full audit in
   each.
2. Run it once through the Agensi connector, piping the script, and record whether the agent
   reproduces the 62 KB script intact.
3. Test a real **English** Studio export, and one exported with **Views** as the chart metric.
4. Have another creator follow `references/export-instructions.md` without help.
5. Decide the price and write the listing images. Don't use real channel data in screenshots;
   use `examples/sample-report.md`.
6. Push the branch and check that the Python CI job passes on Windows and Linux.
