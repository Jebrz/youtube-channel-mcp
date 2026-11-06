# youtube-channel-mcp tool reference (for audits)

Matches youtube-channel-mcp v0.2.0. All tools are read-only. Tool names carry a
prefix that depends on how the server was connected; match on the suffix.

## get_dashboard (prefer this)

Input:

| Argument | Values | Default |
| --- | --- | --- |
| `preset` | `last_7_days`, `last_28_days`, `last_90_days` | `last_28_days` |
| `compare` | `previous_period`, `previous_year` | `previous_period` |
| `force_refresh` | boolean; bypasses the 15-minute cache but is throttled to once a minute | `false` |

Response (JSON text; key fields):

```
reportingPeriod: { current: {startDate, endDate}, comparison: {startDate, endDate} }
lastAttemptAt, lastFullSuccessAt, generatedAt          ISO timestamps
stale: boolean                                          any section not "ok"
cache: { hit, ageSeconds, ttlSeconds, nextForcedRefreshAt, throttled? }
sections:
  overview:       { status, fetchedAt, error?, data: { channel: {channelId, title, customUrl, publishedAt, country},
                                                        statistics: {viewCount, subscriberCount, subscriberCountHidden, videoCount} } }   ← LIFETIME
  summary:        { status, fetchedAt, error?, data: { dateRange, rows: [ {views, engagedViews, estimatedMinutesWatched,
                                                        averageViewDuration, averageViewPercentage, likes, comments, shares,
                                                        subscribersGained, subscribersLost} ],
                                                        comparison: { dateRange, rows, changes: { <metric>: {current, previous, absoluteChange, percentChange} } } } }
  daily:          { …, data: { rows: [ {day, views, estimatedMinutesWatched, subscribersGained, subscribersLost} ], comparison: { dateRange, rows } } }
  topVideos:      { …, data: { rows: [ {video, title, views, estimatedMinutesWatched, averageViewDuration, likes, subscribersGained} ] } }   (top 10, period only)
  trafficSources: { …, data: { rows: [ {insightTrafficSourceType, engagedViews, views, estimatedMinutesWatched} ],
                               comparison: { dateRange, rows, changes: [ {key: {insightTrafficSourceType}, metrics: {<metric>: {current, previous, …}}} ] } } }
notes: string[]
```

`status`: `ok` (fresh), `stale` (last good data kept, `error` explains the failed
refresh), `error` (`data` is null). Error codes include `AUTH_REQUIRED`,
`QUOTA_EXCEEDED`, `METRIC_UNAVAILABLE`, `CONFIG_ERROR`, `API_ERROR`,
`CHANNEL_MISMATCH` (hosted connector only).

## get_channel_analytics

`report`: `summary`, `daily`, `monthly`, `country`, `traffic_source`, `device_type`,
`playback_location`, `demographics`, `sharing_service`, `top_videos`.

Dates: `preset` (`last_7_days`, `last_28_days`, `last_90_days`, `last_365_days`,
`this_month`, `last_month`, `this_year`, `last_year`) **or** `start_date` + `end_date`
(`YYYY-MM-DD`). `monthly` needs whole calendar months.
`compare`: `none` (default), `previous_period`, `previous_year`, `custom`
(+ `compare_start_date`, `compare_end_date`).
`metrics`: optional list; must be allowed for the report (the tool rejects others
with `INVALID_INPUT` and lists the allowed ones). `traffic_source`, `device_type`
and `playback_location` allow only `engagedViews`, `views`,
`estimatedMinutesWatched`. Revenue metrics need the monetary permission.
`top_videos` only: `sort` (default `views`), `max_results` 1–200, `start_index`.

Response: `{ report, dateRange, dimensions, metrics, rows, rowCount, comparison?, notes, query }`.
Keyed reports (country, device, traffic) put joined changes in
`comparison.changes[]`; `daily`/`monthly` return the two series side by side.

## get_video_analytics

Same as above plus required `video_id` (11 characters). Reports: `summary`, `daily`,
`monthly`, `country`, `traffic_source`, `device_type`, `playback_location`,
`demographics`, `sharing_service`, `retention`. `retention` returns rows of
`{elapsedVideoTimeRatio, audienceWatchRatio, relativeRetentionPerformance}` (0.01–1.0;
`relativeRetentionPerformance` 0.5 ≈ typical for similar videos); it is often empty
for low-view videos.

## Other tools

- `get_channel_overview` — lifetime profile and counts (already inside `get_dashboard`).
- `list_videos` — uploads, newest first, `max_results` 1–50, `page_token`; lifetime
  public counts per video.
- `get_video_details` — metadata for 1–50 `video_ids`; reports `notFound` IDs.

## Behaviour to rely on

- Periods end 2 days before today (UTC); YouTube days are Pacific Time.
- Missing values are `null`; empty results are `rows: []` with a note. Nothing is
  filled with zeros.
- One `get_dashboard` refresh costs about 3 YouTube Data API units and 7 Analytics
  queries; cached responses cost nothing.
