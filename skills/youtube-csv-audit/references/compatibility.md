# Requirements and compatibility

## What the skill needs

| Requirement | Detail |
| --- | --- |
| An agent that loads SKILL.md skills | Claude Code, or claude.ai with skills enabled. Others that read SKILL.md may work but haven't been tested. |
| Code execution | Python **3.10 or newer**, standard library only. No packages, no network. |
| File access | The agent must be able to read the uploaded ZIP or CSV files and write a working folder. |
| The export | YouTube Studio → Analytics → Advanced mode → Export current view → CSV. |

It does **not** need: a Google account connection, the YouTube APIs, a Google Cloud project, an MCP
server, or internet access.

## Delivery modes

| How the skill arrives | How the script runs | Tested |
| --- | --- | --- |
| Folder on disk (Claude Code `~/.claude/skills/youtube-csv-audit/`) | `python3 <skill>/scripts/yt_csv_audit.py …` | Script run this way, yes. Not yet run from inside Claude Code by an agent following SKILL.md. |
| ZIP uploaded to claude.ai (Customize → Skills; needs code execution) | Same, from the skill's folder in the sandbox | No |
| Marketplace connector that serves files as text, never saved to disk | Piped: `python3 - <inputs> <<'PY' … PY` | Piping works (automated test). Not tested through a real marketplace connection. |

## Export formats

| Export | Status |
| --- | --- |
| Malay-interface Studio export (Table data, Chart data with subscribers, Totals with subscribers), Nov 2026 | Tested with a real export |
| English-interface Studio export | Synthetic fixtures only. Column names follow YouTube Help wording but haven't been checked against a real English export. |
| Chart data / Totals with Views or Watch time | Synthetic fixtures only |
| Other Studio languages | Not supported yet: columns are reported as unmapped |
| Exports re-saved by Excel or Google Sheets | Partly: semicolon separators, decimal commas, BOMs and UTF-16 are handled; regional date formats like `03/04/2026` are left blank as ambiguous |
| Traffic source, geography, audience or other breakdowns | Not supported: only per-video (Content) exports are analysed. Other tables are reported as unrecognised or analysed only for the columns found. |
| Revenue columns | Ignored by design |

## Limits built into the script

- ZIP files up to 200 MB; each CSV up to 50 MB uncompressed; 100 MB of CSVs per ZIP; 200 entries;
  100,000 rows per file.
- Archives are never extracted to disk. Unsafe entry names, symbolic links, nested ZIPs,
  password-protected entries and suspicious compression ratios are skipped or refused.
- The script writes only `audit_data.json` and `audit_facts.md`, and only to the `--out` folder.

## Tested on

- Python 3.11, 3.12 and 3.13 on Linux (40 automated tests). Python 3.10 and Windows/macOS have CI jobs
  configured, but they haven't run yet.
