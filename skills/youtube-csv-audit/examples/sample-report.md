# Channel audit: Synthetic Example Channel, 2026-01-01 to 2026-01-28

> **SYNTHETIC SAMPLE.** The channel, videos and numbers below are invented. They come from the
> fixture `tests/fixtures/ms_export` (Malay column names, structured like a real Studio export)
> and show what the skill produces. Nothing here describes a real channel.

Prepared from a YouTube Studio export. Figures were computed by yt_csv_audit 0.1.0 (self-test
passed); every number cites its source in the calculation log.

## 1. What this audit covers

- Export: `Content_2026-01-01_2026-01-29_Synthetic Example Channel.zip` with Table data.csv
  (12 videos plus a Total row), Chart data.csv and Totals.csv. Column names are in Malay, and all
  were recognised with confidence "seen".
- Period: 2026-01-01 to 2026-01-28 (28 days), taken from the daily files. The file name says
  2026-01-29; the export either names its end date exclusively or is missing the last day. The
  files don't settle which.
- The first video was published on 2026-01-05, 4 days into the period.
- Daily data available: **net subscribers only.** There are no daily views, watch time or
  impressions in this export, so this audit shows no daily trend for them.
- Not in this export: traffic sources, audience, geography, revenue.

## 2. Headline numbers (period, not lifetime)

| Metric | Value | Source |
| --- | --- | --- |
| Views | 2,692 | F007 |
| Engaged views | 875 | F002 |
| Watch time (hours) | 19.584 | F008 |
| Net subscribers | +3 | F001 |
| Thumbnail impressions | 16,775 | F003 |
| Impressions CTR | 1.6% | F004 |
| Average view duration | 1:35 | F005 |
| Average percentage viewed | 38.1% | F006 |

Reach comes mostly from short videos, and watch time mostly from long ones. Fewer than a third of
views were engaged views (875 of 2,692), so many plays didn't get past the first seconds.

## 3. What is working

- **One short video carries the channel.** "Synthetic Short: Three Prompt Mistakes #shorts" (row 3)
  has 1,200 views, 44.58% of all views (F009). It also has the highest CTR among videos with at
  least 100 impressions (4.1%) and the highest average percentage viewed (71.4%) among videos with
  at least 10 engaged views.
- **Short-length videos are watched further.** The six videos of 60 seconds or less have a median
  average percentage viewed of 55.3%. Videos over 3 minutes have 31.3% (F012, F014).
- **Long videos earn the watch time.** The three videos over 3 minutes have 13.8 of the period's
  watch hours, with only 340 views (F014). Their engaged share is high: 79.4% of their views were
  engaged views.

## 4. Where performance leaks

- **Long videos get impressions but few clicks.** The three over-3-minute videos have 11,900 of the
  16,775 impressions, with an impression-weighted CTR of 1.01%. The 0-60 s group's is 2.85% (F014,
  F012). The two most-shown thumbnails are below the channel's 1.6%: "How Search Works" (row 5,
  5,200 impressions, 1.2%) and "Note-Taking Systems" (row 7, 4,100 impressions, 0.9%).
- **Short-length plays rarely become engaged views.** Only 23.6% of 0-60 s views were engaged
  views, against 79.4% for videos over 3 minutes (F012, F014). Short-length videos also get many
  views that don't come from thumbnail impressions (2,220 views from 1,925 impressions), so judge
  them on engaged views and percentage viewed rather than CTR.
- **Views are concentrated.** The top 3 videos have 71.32% of views (F010). One weak week for
  short videos would show up immediately in the channel total.
- **Subscribers barely move.** Net +3 for the period (F001), on 5 days of 28 (F016). "Battery
  Myth" (row 9) is net −1.

## 5. Publishing pattern

- 12 videos in 4 weeks: 4, 3, 3 and 2 per ISO week (weeks 2 to 5 of 2026). The pace is slowing.
- 3 videos were live for 7 days or less by 2026-01-28, so their figures are still early. One of them,
  "Keyboard Tip" (row 13), has no views, watch time or retention reported (blank cells, not zero).
- All 12 videos were published inside the period, so these figures are close to their lifetime
  figures. That isn't true for older channels.

## 6. Three experiments

### Experiment 1: Repackage the long explainers

- **Evidence:** packaging signal: 6 of 10 videos with at least 100 impressions are below the 1.6%
  channel CTR (F004). The long group's CTR is 1.01% on 11,900 impressions (F014). Rows 5, 7 and 11
  have the most impressions and the lowest CTRs.
- **Hypothesis:** the long videos are shown often but their title and thumbnail don't promise a
  clear payoff. A specific, outcome-led title and a simpler thumbnail will raise CTR.
- **Change:** for the next 3 long videos, use one concrete outcome in the title (e.g. "Set up
  backups in 10 minutes"), and a thumbnail with at most 3 words. Leave topics and length as usual.
- **Compare:** `Kadar klikan lakaran kecil (%)` and `Tera lakaran kecil` for those 3 videos in the
  next export, against rows 5, 7 and 11 here (median CTR 0.9%).
- **Success threshold:** median CTR of the 3 new long videos at least 1.5%, each with at least
  1,000 impressions.
- **Minimum run:** 3 videos, each live at least 14 days before judging.
- **What could fool us:** a more popular topic, a long video picked up by search, or an
  impressions drop that raises CTR mechanically. Compare impressions too.

### Experiment 2: A stronger first 3 seconds for short videos

- **Evidence:** engaged_share signal: only 23.6% of 0-60 s views were engaged views (F012), against
  79.4% over 3 minutes (F014). The best short (row 3) reached 25.8% engaged per view and 71.4%
  average percentage viewed.
- **Hypothesis:** viewers swipe away before the point of the short is clear. Stating the payoff in
  the first sentence and showing the result first will keep more viewers past the opening.
- **Change:** for the next 6 short videos, open with the end result on screen and a one-line claim.
  Keep length under 60 seconds.
- **Compare:** `Tontonan sahih` ÷ `Tontonan` (engaged per view) and `Purata peratusan ditonton (%)`
  for those 6, against the 0-60 s group here.
- **Success threshold:** engaged per view at least 30% across the 6 (sum of engaged views ÷ sum of
  views), and median average percentage viewed not below 55.3%.
- **Minimum run:** 6 videos, each with at least 100 views before judging.
- **What could fool us:** a different view-counting rule if YouTube changes definitions again, or one
  viral short dominating the sum. Check the median per video as well.

### Experiment 3: Ask for the subscribe on the videos that already convert

- **Evidence:** subscribers signal: net +3 in 28 days (F001). Gains came from row 3 (+2), row 5 (+1)
  and row 7 (+1). The long explainers convert best per view (5.56 and 9.09 net subscribers per 1,000
  views for rows 5 and 7). Row 9 lost one.
- **Hypothesis:** viewers who finish a long explainer are the most likely to subscribe. A specific
  reason to subscribe near the end of long videos will lift conversion.
- **Change:** in the next 3 long videos, add one 10-second line before the end naming what the next
  video will solve, plus an end screen pointing to the related short.
- **Compare:** `Pelanggan` per video, and the per-1,000-views rate computed by the script, against
  rows 5, 7 and 11.
- **Success threshold:** at least 5 net subscribers per 1,000 views across the 3 new long videos,
  with at least 300 views between them.
- **Minimum run:** 3 videos over at least 3 weeks. Subscriber numbers this small swing on one
  person, so don't judge sooner.
- **What could fool us:** very small counts (one subscriber changes the rate a lot), and
  subscribers gained from other videos or the channel page that day.

## 7. Data notes and limits

- The Total row is slightly higher than the sum of the 12 listed videos: views +12 (0.45%),
  impressions +30, engaged views +4 and watch time +0.05 h. YouTube counts deleted videos in totals.
  The channel figures above use the Total row.
- Blank cells: "Keyboard Tip" (row 13) has no views, engaged views, subscribers or watch time.
  "Keyboard Tip" and "Focus Timer" (row 14) have no average view duration or percentage viewed.
  These are treated as not reported, not zero.
- Chart data has 40 daily rows dated before the charted video was published, all zero. The export
  fills them; they aren't activity.
- Average view duration (1:35) comes from the export. YouTube calculates it from engaged views,
  so it doesn't equal watch time ÷ views (which gives 26.2 s here).
- Shorts aren't marked in the export. "0-60 s" and "61-180 s" are length groups, not a Shorts
  label.
- **For a better next audit,** choose **Views** as the chart metric before exporting. This export's
  daily files contain subscribers only.

## Calculation log

| Fact | What | Value | How | Source |
| --- | --- | --- | --- | --- |
| F001 | Channel total: net subscribers | 3 | Total row as exported | S1.1 'Pelanggan' row 2 |
| F002 | Channel total: engaged views | 875 | Total row as exported | S1.1 'Tontonan sahih' row 2 |
| F003 | Channel total: thumbnail impressions | 16775 | Total row as exported | S1.1 'Tera lakaran kecil' row 2 |
| F004 | Channel total: impressions CTR (%) | 1.6 | Total row as exported | S1.1 'Kadar klikan lakaran kecil (%)' row 2 |
| F005 | Channel total: average view duration (s) | 95 | Total row as exported | S1.1 'Purata tempoh tontonan' row 2 |
| F006 | Channel total: average percentage viewed (%) | 38.1 | Total row as exported | S1.1 'Purata peratusan ditonton (%)' row 2 |
| F007 | Channel total: views | 2692 | Total row as exported | S1.1 'Tontonan' row 2 |
| F008 | Channel total: watch time (hours) | 19.584 | Total row as exported | S1.1 'Masa tontonan (jam)' row 2 |
| F009 | Share of views from the top video | 44.58 | highest per-video views / total views × 100 | S1.1 'Tontonan' rows 2-14 |
| F010 | Share of views from the top 3 videos | 71.32 | sum of 3 highest per-video views / total views × 100 | S1.1 'Tontonan' rows 2-14 |
| F012 | Length group 0-60 s | 2220 views | 6 videos; sums and medians over their rows | S1.1 rows 3,4,6,9,12,13 |
| F014 | Length group over 180 s | 340 views | 3 videos; sums and medians over their rows | S1.1 rows 5,7,11 |
| F016 | Totals file daily net subscribers: sum | 3 | sum of 28 daily values | S1.3 'Pelanggan' rows 2-29 |
| (row values) | Per-video figures and per-1,000-view subscriber rates | — | from `videos` in audit_data.json | S1.1 rows 3-14 |
