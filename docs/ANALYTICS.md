# Analytics reports: supported combinations

Every report below maps to a report table in Google's official
[YouTube Analytics API: Channel Reports](https://developers.google.com/youtube/analytics/channel_reports)
documentation. The metric lists were checked against that page and the
[revision history](https://developers.google.com/youtube/analytics/revision_history) on
**2026-11-03**. The source of truth in code is [`src/analytics/reports.ts`](../src/analytics/reports.ts).

All queries use `ids=channel==MINE`. Video reports add `filters=video==<VIDEO_ID>`, which every
report table listed here allows.

| Report id | Dimensions | Allowed metrics | Official report table | Channel | Video |
| --- | --- | --- | --- | :-: | :-: |
| `summary` | none | core set (below) | Basic stats → *Basic user activity statistics* | ✓ | ✓ |
| `daily` | `day` | core set | Time-based → *User activity by country for specific time periods* | ✓ | ✓ |
| `monthly` | `month` | core set | same as above, with `month` | ✓ | ✓ |
| `country` | `country` | core set | User geography → *User activity by country* | ✓ | ✓ |
| `traffic_source` | `insightTrafficSourceType` | `engagedViews`, `views`, `estimatedMinutesWatched` | Traffic sources → *Traffic source* | ✓ | ✓ |
| `device_type` | `deviceType` | `engagedViews`, `views`, `estimatedMinutesWatched` | Device type and operating system → *Device type* | ✓ | ✓ |
| `playback_location` | `insightPlaybackLocationType` | `engagedViews`, `views`, `estimatedMinutesWatched` | Playback locations → *Video playback location report* | ✓ | ✓ |
| `demographics` | `ageGroup`, `gender` | `viewerPercentage` | Viewer demographics | ✓ | ✓ |
| `sharing_service` | `sharingService` | `shares` | Engagement and content sharing | ✓ | ✓ |
| `top_videos` | `video` | core set; `sort` ∈ {views, redViews, estimatedRevenue, estimatedRedPartnerRevenue, estimatedMinutesWatched, estimatedRedMinutesWatched, subscribersGained, subscribersLost}; `maxResults` ≤ 200 (both required) | Top videos → *Top videos with optional regional filters* | ✓ | |
| `retention` | `elapsedVideoTimeRatio` | `audienceWatchRatio`, `relativeRetentionPerformance`, `startedWatching`, `stoppedWatching`, `totalSegmentImpressions` | Audience retention (single `video` filter required) | | ✓ |

**Core metric set** (basic, time-based, country and top-videos tables):
`engagedViews`, `views`, `redViews`, `comments`, `likes`, `dislikes`, `videosAddedToPlaylists`,
`videosRemovedFromPlaylists`, `shares`, `estimatedMinutesWatched`, `estimatedRedMinutesWatched`,
`averageViewDuration`, `averageViewPercentage`, `cardClickRate`, `cardTeaserClickRate`,
`cardImpressions`, `cardTeaserImpressions`, `cardClicks`, `cardTeaserClicks`, `subscribersGained`,
`subscribersLost`, plus the monetary metrics below.

**Monetary metrics** (`estimatedRevenue`, `estimatedAdRevenue`, `grossRevenue`,
`estimatedRedPartnerRevenue`, `monetizedPlaybacks`, `playbackBasedCpm`, `adImpressions`, `cpm`):
these need the `yt-analytics-monetary.readonly` scope (run `auth --monetary`) and a channel in the
YouTube Partner Program. Without that, Google returns `403 Forbidden`. This server checks the
scope locally before calling Google. Use `currency` (ISO 4217) to choose the currency.

## Deliberately excluded

| Item | Why |
| --- | --- |
| `annotation*` metrics | Still listed in the docs, but YouTube removed annotations in 2019, so they only return zeros. |
| `uniques` | Legacy metric that only appears in some time-based tables. |
| `isCurated` dimension | Deprecated for channel reports (revision history: 2024-01-19 / 2025-04-22). |
| Playlist reports | Playlist reports changed in 2024 (new `playlist*` in-playlist metrics, `redViews` removed). Planned for a later version. |
| Province/city/DMA geography, `operatingSystem`, `youtubeProduct`, `subscribedStatus` breakdowns | Valid per the docs, but left out of v0.1 to keep the tool surface small. Easy to add in `reports.ts`. |
| Thumbnail impressions / CTR | Added Jan 2026 to the bulk **Reporting API** (reach reports), not to `reports.query`. Out of scope. |
| Livestream concurrent viewers | Valid for single live videos; planned. |

## Validation and error behaviour

1. **Local validation before any API call.** Unknown reports, metrics not allowed for the report,
   malformed dates, monthly ranges that don't start on the 1st and end on a month's last day,
   invalid `top_videos` sort or `maxResults`, malformed video IDs, and monetary metrics without
   the monetary scope all return `INVALID_INPUT` or `AUTH_REQUIRED` with the allowed values.
2. **Google-side rejections.** The documentation notes that Google also enforces cross-parameter
   rules. A `400 "The query is not supported"` comes back as `METRIC_UNAVAILABLE`. For example,
   `traffic_source` errors when *(videos × days) > 50,000*.
3. **Empty results.** If Google returns no rows, the tool returns `rows: []` with a note. It never
   returns zeros or estimates. Comparison values for a missing period are `null`.

## Comparison periods

| `compare` | Comparison range |
| --- | --- |
| `previous_period` | The same number of days just before the range. If the range covers whole calendar months, the comparison covers the same number of whole months (e.g. Mar → Feb). |
| `previous_year` | The same dates one year earlier (Feb 29 → Feb 28). |
| `custom` | `compare_start_date` … `compare_end_date` |

Results:

- `summary`: `comparison.changes[metric] = { current, previous, absoluteChange, percentChange }`.
  `percentChange` is `null` when `previous` is 0 or missing.
- Non-time dimensional reports (`country`, `traffic_source`, `top_videos`, …): rows are joined on
  the dimension values. A `null` means that key had no row in that period, not that the value
  was zero.
- `daily` / `monthly`: the two series come back side by side (`rows` and `comparison.rows`),
  because their dates don't line up.

## Dates and latency

Presets are computed in UTC and end **2 days before today**, because YouTube Analytics data is
typically 2–3 days behind. YouTube Analytics itself reports days in Pacific Time. Custom ranges
are passed through unchanged.
