# Report template

Fill every section. Where data is unavailable, keep the heading and say why.

```markdown
# Channel audit: <channel title> (<@handle or channel ID>)

## 1. Channel and reporting dates
- Reporting period: <start> to <end> (YouTube Analytics days, Pacific Time)
- Compared with: <start> to <end> (<previous period | same period last year>)
- Lifetime, all-time totals (YouTube Data API, not limited to the period):
  <views> views · <subscribers, rounded by YouTube | hidden> subscribers · <n> public videos · created <date>

## 2. Data sources, fetch times and limitations
- Source: youtube-channel-mcp `<tool(s)>`; fetched <time> (<fresh | server cache, N min old>)
- Sections unavailable or stale: <none | section: reason>
- Limitations that affect this report: <data lag; small numbers; comparison before channel existed; metric definition changes; country attribution; …>

## 3. Performance summary
| Metric (period) | Current | Comparison | Change |
| --- | --- | --- | --- |
| Views | | | |
| Watch time (minutes) | | | |
| Average view duration | | | |
| Subscribers gained / lost | | | |
<Use "n/a" for % change when the comparison value is 0 or missing.>

Daily pattern: <what the daily rows show; name days with no data as unavailable>

## 4. Top videos and traffic sources
Top videos this period: <top 3–5 with views and watch time; one-line observation each>
Traffic sources: <largest sources, shares, notable changes vs comparison>
<Optional: countries / devices / retention for <video>, if fetched>

## 5. Three prioritized actions
1. **<Action>** — Evidence: <metric, value, period>. Why first: <impact/effort/confidence>.
2. **<Action>** — Evidence: … Why: …
3. **<Action>** — Evidence: … Why: …
(Label any reasoning about causes as a hypothesis.)

## 6. Suggested experiments
| Experiment | Change | Videos | Duration | Metric | Success if | Inconclusive if |
| --- | --- | --- | --- | --- | --- | --- |

*Recommendations are suggestions to test, not predictions. Numbers are from the
connector as fetched above; re-run the audit to see newer data.*
```
