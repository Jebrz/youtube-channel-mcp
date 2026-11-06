# How to export your YouTube data (for the creator)

You don't need to sign in anywhere else or share a password. You download a file from YouTube Studio
and upload that file.

## On a computer (YouTube Studio in a browser)

1. Go to [studio.youtube.com](https://studio.youtube.com) and open **Analytics** in the left menu.
2. Click **Advanced mode** (top right). The menu labels can vary: from July 2026 YouTube has been
   rolling out an updated Studio, so the Analytics page may look a little different.
3. Choose the **date range** at the top right, for example the last 28 or 90 days. Write down the dates.
4. Keep the table broken down by **Content** (one row per video). It's the default.
5. Optional, for daily trends: in the chart's metric menu, pick **Views**. In the exports we've seen,
   the daily files held only the chart's metric: a chart showing subscribers gave daily subscribers
   only. Exporting with Views selected should give daily views, but we haven't tested that yet.
6. Click **Export current view** (the down-arrow icon), then **Comma-separated values (.csv)**.
7. A ZIP file downloads, named like `Content_2026-08-07_2026-11-05_Your Channel.zip`. Upload that
   ZIP as it is. Don't open and re-save the CSV files in Excel first: that can change number and
   date formats.

The ZIP normally holds three files:

| File | What's in it |
| --- | --- |
| `Table data.csv` | One row per video, plus a Total row: views, watch time, impressions, CTR, retention, subscribers |
| `Chart data.csv` | One row per day per charted video, for the chart's metric only |
| `Totals.csv` | One row per day for the whole channel, for the chart's metric only |

## Good to know

- Studio exports at most **500 rows**, so a channel with more videos gets only 500 of them.
- English and Malay Studio languages are supported. Other languages may export column names the
  audit doesn't recognise yet; it will say which.
- The export doesn't include revenue unless you add revenue columns, and the audit ignores revenue
  anyway.
- Your file stays in the conversation you upload it to. The audit doesn't send it anywhere.
- These steps are for YouTube Studio in a computer browser. The export steps in the phone app
  haven't been checked.
