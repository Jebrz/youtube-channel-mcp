# YouTube CSV Channel Audit (skill)

A standalone skill that audits a YouTube channel from the files YouTube Studio exports. No Google
sign-in, no API keys, no Google Cloud project and no MCP connector are involved: the creator uploads
the ZIP and the agent runs a bundled Python script that does the arithmetic.

- **Input:** the ZIP from YouTube Studio → Analytics → Advanced mode → Export current view → CSV
  (`Table data.csv`, `Chart data.csv`, `Totals.csv`), with English or Malay column names.
- **Output:** a Markdown audit with headline numbers, what works, where performance leaks,
  publishing pattern, three experiments and a calculation log. Every figure cites a file, row and
  column.
- **Needs:** an agent with code execution and Python 3.10+ (standard library only).

This is a separate product from the MCP-based `youtube-channel-audit` skill in the same repository.

## Install

**Claude Code:** copy this folder to `~/.claude/skills/youtube-csv-audit/` (Windows:
`%USERPROFILE%\.claude\skills\youtube-csv-audit\`). Then ask Claude to audit your export and attach
the ZIP.

**claude.ai:** upload the release ZIP under Customize → Skills. Code execution must be on.

## Run the script yourself

```bash
python3 scripts/yt_csv_audit.py --selftest
python3 scripts/yt_csv_audit.py "Content_2026-08-07_2026-11-05_My Channel.zip" --out yt-audit
```

This writes `yt-audit/audit_data.json` and `yt-audit/audit_facts.md`. Nothing is sent anywhere.

## Files

| Path | Purpose |
| --- | --- |
| `SKILL.md` | Instructions the agent follows |
| `scripts/yt_csv_audit.py` | The analyser: one file, standard library only, no network, never extracts archives to disk |
| `references/audit-template.md` | Report structure and experiment format |
| `references/metric-definitions.md` | Metric meanings with YouTube Help sources, and export quirks |
| `references/column-mapping.md` | English/Malay column names and confidence levels |
| `references/export-instructions.md` | Export steps to give the creator |
| `references/compatibility.md` | Requirements and what has been tested |
| `examples/sample-report.md` | A full report on a **synthetic** export |
| `tests/` | Automated tests and synthetic fixtures (development only; not in the release ZIP) |

## Tests

```bash
python3 -m unittest discover -s skills/youtube-csv-audit/tests -v
```

Run from the repository root. The tests use synthetic data only. See
`references/compatibility.md` for what has and hasn't been verified.

## Privacy

Exports contain a creator's private analytics. Don't commit real exports or generated reports to a
repository. The release ZIP is checked to contain no CSV, ZIP or JSON files.
