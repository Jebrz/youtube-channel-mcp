# Metric definitions and export behaviour

Sources are YouTube Help pages, checked on 2026-11-06. Behaviour marked **observed** was seen in a
real export during testing but isn't documented by YouTube; treat it as likely, not certain.

## Metrics

| Metric | Meaning | Notes |
| --- | --- | --- |
| Views | Counted the moment a video starts to play, for all formats, from 2026-08-24 [1] | Before that date, long-form views and Shorts views used different rules (see below). |
| Engaged views | "How many times viewers stayed to watch past the initial seconds, not including any loops" [1] | Usually lower than views, especially for Shorts. |
| Watch time (hours) | "The amount of time viewers have watched your video" [1] | Additive: video rows add up (Total row may be higher, see below). |
| Average view duration | "Average minutes watched among those who stayed to watch … calculated from engaged views and their corresponding watch time" [1] | So it is **not** watch time ÷ views. Use the exported value. |
| Average percentage viewed | Average percentage of a video watched among those who stayed to watch, from engaged views [1] | **Observed:** values above 100% occur for short videos. Report as exported. |
| Thumbnail impressions | "How many times your thumbnails were shown to viewers on YouTube through registered thumbnail impressions" [1] | Older exports call it "Impressions". |
| Impressions click-through rate | "How often viewers watched a video after seeing a thumbnail" [1] | A percentage: never add it across videos. **Observed:** Short-length videos often have more views than impressions and 0% CTR, suggesting many of their views don't come from thumbnail impressions. |
| Subscribers | Net change (gained minus lost) in the period, per video or per day | Can be negative. |

## View-counting changes

- **2025-03-31:** Shorts views began counting each start or replay. The previous Shorts view metric
  continued as "engaged views" [2].
- **2026-08-24:** "views are counted the moment a video starts to play across all formats, including
  Shorts, long-form videos (VOD), and live streams" [1].

If a period spans one of these dates, the script adds a note. Views before and after the change
aren't directly comparable; engaged views are the steadier comparison.

## Export behaviour

- **500-row limit.** "Downloaded reports are limited to 500 rows" [3]. A channel with more videos
  gets only the first 500 rows.
- **Deleted videos.** "Data from deleted items will still be counted in aggregate stats and totals"
  [3]. That's one reason the Total row can exceed the sum of the listed videos.
- **Chart data and Totals.** **Observed:** these hold the daily values of the chart's metric at export
  time, not every metric. The tested export had subscriber counts only. Choosing a different chart
  metric before exporting should change what they contain. That hasn't been tested.
- **Days before publication.** **Observed:** Chart data lists every day of the period for each charted
  video, with zeros before the video existed. The script flags these rows.
- **File name dates.** **Observed:** the ZIP name's end date was one day after the last daily row.
  The script reports both and doesn't guess which is right.
- **No Shorts flag.** The export has a Duration column but doesn't say which videos are Shorts.

## Sources

1. YouTube Help, "Understand your YouTube content performance":
   https://support.google.com/youtube/answer/12220281
2. YouTube Help community announcement, "A Change to How We Count Views on Shorts":
   https://support.google.com/youtube/thread/333869549
3. YouTube Help, "Learn how to use Advanced mode for analytics reports":
   https://support.google.com/youtube/answer/9717005
