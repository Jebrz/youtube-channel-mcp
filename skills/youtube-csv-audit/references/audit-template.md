# Audit report template

Use these sections in this order. Replace the guidance in *italics*. Cite a fact ID (`F007`) or a
row (`S1.1 row 5`) after every number. Keep it plain: short sentences, no jargon without a gloss.

```markdown
# Channel audit: <channel or file name>, <period start> to <period end>

Prepared from a YouTube Studio export on <date of writing>. Figures were computed by
yt_csv_audit <version> (self-test passed); every number cites its source in the calculation log.

## 1. What this audit covers

- Export: <ZIP/file names>, <language of column names>, <number of videos listed>.
- Period: <start> to <end> (<days> days). Basis: <period.basis>. <period notes in plain words>
- Daily data available: <daily.metrics_available, or "none">.
- Not in this export: <daily.not_available, revenue, traffic sources, audience, etc.>
- <Any mapping confidence other than "seen", and any assumption the user confirmed.>

## 2. Headline numbers (period, not lifetime)

| Metric | Value | Source |
| --- | --- | --- |
| Views | … | F… |
| Engaged views | … | F… |
| Watch time (hours) | … | F… |
| Net subscribers | … | F… |
| Thumbnail impressions | … | F… |
| Impressions CTR | …% | F… |
| Average view duration | m:ss | F… |
| Average percentage viewed | …% | F… |

*Two or three sentences: what these say together. Only metrics present in the export.*

## 3. What is working

*Two to four findings, each one sentence of claim + the evidence (video rows, fact IDs). Name the
videos by title. Prefer comparisons the script computed (share of views, length groups,
rankings above thresholds).*

## 4. Where performance leaks

*Two to four findings: packaging (impressions vs CTR), retention (average percentage viewed by
length group), engaged share, concentration on a few videos, subscriber conversion. Each with
evidence. Say "too few to judge" where thresholds exclude most videos.*

## 5. Publishing pattern

*Uploads per week, gaps, how many videos are still young (live 7 days or less), and videos
published before the period (period figures are partial). Only from `publishing`.*

## 6. Three experiments

### Experiment 1: <short name>

- **Evidence:** <signal id + fact IDs/rows, with the numbers>
- **Hypothesis:** <if we change X, Y will improve because …>
- **Change:** <one concrete change, applied to which upcoming videos>
- **Compare:** <exact export column(s), e.g. "Impressions click-through rate (%)" for the next
  N videos vs. the median of the last N in this export>
- **Success threshold:** <a number decided now, e.g. median CTR at least 0.5 points higher>
- **Minimum run:** <number of videos and/or days, and minimum impressions/views per video before
  judging>
- **What could fool us:** <confounders: topic, season, a viral outlier, definition changes,
  young videos>

### Experiment 2: <short name>
*(same fields)*

### Experiment 3: <short name>
*(same fields)*

*Each experiment starts from a different signal where possible: for example packaging,
retention/length, and publishing or subscriber conversion. Don't propose anything the next export
can't measure.*

## 7. Data notes and limits

- *Reconciliation: Total row vs sum of rows (from `reconciliation`), and why they can differ.*
- *Blank cells per column (from `missing_values`). Blank means not reported, not zero.*
- *Definition changes in the period (from `period.notes`).*
- *Warnings that affected the analysis, in plain words.*
- *What a better export would add: e.g. choose "Views" as the chart metric before exporting to get
  daily views, or export Traffic source for discovery.*

## Calculation log

| Fact | What | Value | How | Source |
| --- | --- | --- | --- | --- |
*Copy the script's calculation log rows you cited, plus any figure you computed yourself with Python
(formula and inputs).*
```

## Writing guidance

- Lead with findings, not method. The data-quality notes go in section 7, not the opening.
- Use the creator's terms: "views", "watch time", "click-through rate (CTR): how often a shown
  thumbnail was clicked".
- Durations as m:ss (95 s → 1:35). Percentages with the precision exported.
- Never call a change "significant"; the script doesn't run significance tests. Say "higher",
  "lower", or "too few to judge".
- Don't rank or praise a video on fewer views or impressions than the thresholds in `rankings`.
