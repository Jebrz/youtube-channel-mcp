# Sample report (FICTIONAL)

> **Everything below is invented** for "Example Channel", a channel that does not
> exist. It shows the expected structure and tone only. It is not real data, not
> anyone's channel, and not a benchmark.

# Channel audit: Example Channel (@examplechannel)

## 1. Channel and reporting dates
- Reporting period: Oct 5 to Nov 1, 2026 (YouTube Analytics days, Pacific Time)
- Compared with: Sep 7 to Oct 4, 2026 (previous period)
- Lifetime, all-time totals (YouTube Data API, not limited to the period):
  48,210 views · 1,230 subscribers (rounded by YouTube) · 87 public videos · created Mar 2, 2024

## 2. Data sources, fetch times and limitations
- Source: youtube-channel-mcp `get_dashboard` (last_28_days vs previous_period), fetched Nov 3, 2026 09:14 UTC (server cache, 4 min old); `get_channel_analytics` country report, fetched 09:15 UTC.
- Sections unavailable or stale: none.
- Limitations: data lags 2–3 days; Oct 31 and Nov 1 had no daily rows yet (unavailable, not zero). Country rows cover 3,900 of 5,400 views, so country shares are of attributed views only.

## 3. Performance summary
| Metric (period) | Current | Comparison | Change |
| --- | --- | --- | --- |
| Views | 5,400 | 4,500 | +900 (+20%) |
| Watch time (minutes) | 9,100 | 8,800 | +300 (+3.4%) |
| Average view duration | 1:41 | 1:57 | −0:16 (−13.7%) |
| Subscribers gained / lost | 42 / 9 | 30 / 7 | +12 / +2 |

Daily pattern: views stayed between 120 and 260 a day, with one spike to 610 on Oct 17, the day "How I Edit Faster" was published.

## 4. Top videos and traffic sources
Top videos this period:
1. "How I Edit Faster" — 1,450 views, 3,020 minutes. Published in the period; drove the Oct 17 spike.
2. "Budget Camera Test" — 820 views, 1,900 minutes. Strongest average view duration of the top five (2:19).
3. "5 Mistakes Beginners Make" (Short) — 790 views, 210 minutes.

Traffic sources: YouTube search 38% of views (2,050; +31% vs 1,560), Suggested videos 27% (1,460; −4%), Shorts feed 19% (1,030; +62% vs 635). The growth in views came mostly from search and the Shorts feed.

## 5. Three prioritized actions
1. **Follow up on "How I Edit Faster" with a second editing tutorial.** Evidence: it took 27% of period views and 33% of watch time. Why first: largest single source of growth; low effort to repeat the format. (Hypothesis: the topic, not the publish day, drove interest.)
2. **Investigate the drop in average view duration.** Evidence: 1:41 vs 1:57 (−13.7%) while views rose. Why: it may reflect more Shorts views (short by design) rather than weaker long videos; check long videos separately before changing anything. (Hypothesis.)
3. **Add search-oriented titles to two older tutorials.** Evidence: search grew to 38% of views (+31%). Why third: promising but slower to measure.

## 6. Suggested experiments
| Experiment | Change | Videos | Duration | Metric | Success if | Inconclusive if |
| --- | --- | --- | --- | --- | --- | --- |
| Editing follow-up | Publish one more editing tutorial in the same format | 1 new | Two 28-day periods | Views and watch time in first 28 days | ≥ 1,000 views and ≥ 2,000 minutes (≈ 70% of the original) | 600–1,000 views: repeat once more before deciding |
| Search titles | Retitle 2 older tutorials with the main search phrase first | 2 existing | 28 days after change vs 28 days before | YouTube search views to those videos (`get_video_analytics` traffic_source) | Search views to the pair up ≥ 25% | Change under ±10%, or under 100 search views in total |

*Recommendations are suggestions to test, not predictions. Numbers are fictional.*
