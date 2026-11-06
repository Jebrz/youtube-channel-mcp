# youtube-channel-audit skill

A companion skill for [youtube-channel-mcp](../../README.md). It tells an AI agent how to
turn the connector's read-only data into a consistent, evidence-based audit of your
own YouTube channel. **It does not connect to YouTube by itself**: you need a working
youtube-channel-mcp connector first (local Claude Code setup or the hosted connector).

## Contents

| File | Purpose |
| --- | --- |
| `SKILL.md` | Workflow: check the connector, fetch with `get_dashboard` first, read the data correctly, write the report |
| `references/tool-reference.md` | The connector's tool arguments and response fields (v0.2.0) |
| `references/report-template.md` | The six-section report layout |
| `references/sample-report.md` | A fully **fictional** example report |
| `evals/` | Test cases in the `claude plugin eval` folder format |

## Install

- **Claude Code (personal skill):** copy this folder to `~/.claude/skills/youtube-channel-audit/`
  (Windows: `%USERPROFILE%\.claude\skills\youtube-channel-audit\`), then restart Claude Code.
- **Claude Code (one project):** copy it to `<project>/.claude/skills/youtube-channel-audit/`.
- **claude.ai:** zip the folder so the ZIP contains `youtube-channel-audit/` at its root, then upload it
  in **Customize > Skills > Upload a skill** (requires code execution to be enabled; see
  [Use skills in Claude](https://support.claude.com/en/articles/12512180-use-skills-in-claude)).
  The audit also needs the connector added to claude.ai, which means the hosted setup.

## What has been tested

| Environment | What was checked | Result |
| --- | --- | --- |
| Claude Code (cloud session, CLI 2.1.318), connector attached as a claude.ai custom connector, real channel | The author followed `SKILL.md` by hand once: one `get_dashboard` call (last_28_days vs previous_period) and the six-section template | Worked. The run surfaced a real edge case (comparison period before the channel existed), which led to the "offer a shorter preset" rule. The report contains private analytics and is not included |
| Same session, separately | `get_channel_analytics` country and device_type, and `get_video_analytics` summary/daily/retention were called while building the dashboard | Returned data; not yet exercised *through* the skill |
| `evals/` cases | Written, **not yet run** with `claude plugin eval` (they need a connected channel) | Not run |
| Independent agent runs (with vs without the skill) | Not done | Unknown |
| claude.ai chat, Claude Desktop, other agents | Not tested | Unknown |

Run the eval cases yourself, with the connector registered as `youtube-channel`, from this folder:

```bash
claude plugin eval . --allow-tools Write
```

These are real, billed model runs that read your channel's analytics.
