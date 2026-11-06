# Column mapping (English and Malay)

The script matches column headers exactly, ignoring letter case and extra spaces. A header it doesn't
know is listed as `unmapped` and isn't analysed. Revenue-type columns (revenue, RPM, CPM, earnings,
*hasil*, *pendapatan*, or "(USD)"/"(MYR)" in the name) are dropped without being read.

**Confidence:**

- `seen`: present in a real YouTube Studio export that was used in testing (Malay interface,
  November 2026).
- `expected`: the wording YouTube Studio and YouTube Help use in English. It hasn't yet been checked
  against a real English export by this project.
- `guess`: a plausible Malay wording not yet seen in a real export.

Files are recognised by their columns, not their names: a file with `date` and `video_id` is Chart
data, `date` without `video_id` is Totals, and `video_id` without `date` is Table data. Localised file
names therefore work too.

This table must match `COLUMNS` in `scripts/yt_csv_audit.py`; a test checks that.

| Key | Header | Language | Confidence |
| --- | --- | --- | --- |
| `video_id` | Content | en | expected |
| `video_id` | Kandungan | ms | seen |
| `title` | Video title | en | expected |
| `title` | Tajuk video | ms | seen |
| `published` | Video publish time | en | expected |
| `published` | Masa penerbitan video | ms | seen |
| `duration_s` | Duration | en | expected |
| `duration_s` | Tempoh | ms | seen |
| `date` | Date | en | expected |
| `date` | Tarikh | ms | seen |
| `views` | Views | en | expected |
| `views` | Tontonan | ms | seen |
| `engaged_views` | Engaged views | en | expected |
| `engaged_views` | Tontonan sahih | ms | seen |
| `watch_time_h` | Watch time (hours) | en | expected |
| `watch_time_h` | Masa tontonan (jam) | ms | seen |
| `subscribers` | Subscribers | en | expected |
| `subscribers` | Pelanggan | ms | seen |
| `subscribers_gained` | Subscribers gained | en | expected |
| `subscribers_gained` | Pelanggan diperoleh | ms | guess |
| `subscribers_lost` | Subscribers lost | en | expected |
| `subscribers_lost` | Pelanggan hilang | ms | guess |
| `impressions` | Impressions | en | expected |
| `impressions` | Thumbnail impressions | en | expected |
| `impressions` | Tera | ms | guess |
| `impressions` | Tera lakaran kecil | ms | seen |
| `ctr_pct` | Impressions click-through rate (%) | en | expected |
| `ctr_pct` | Thumbnail impressions click-through rate (%) | en | expected |
| `ctr_pct` | Kadar klikan tera (%) | ms | guess |
| `ctr_pct` | Kadar klikan lakaran kecil (%) | ms | seen |
| `avg_view_duration_s` | Average view duration | en | expected |
| `avg_view_duration_s` | Purata tempoh tontonan | ms | seen |
| `avg_pct_viewed` | Average percentage viewed (%) | en | expected |
| `avg_pct_viewed` | Purata peratusan ditonton (%) | ms | seen |
| `likes` | Likes | en | expected |
| `likes` | Suka | ms | guess |
| `comments` | Comments added | en | expected |
| `comments` | Ulasan ditambah | ms | guess |
| `shares` | Shares | en | expected |
| `shares` | Perkongsian | ms | guess |
| `unique_viewers` | Unique viewers | en | expected |
| `unique_viewers` | Penonton unik | ms | guess |

**Total row:** a first cell of `Total`, `Totals`, `Grand total`, `Jumlah` or `Jumlah keseluruhan`.
In a Table data file, a row 2 with no video ID or title but with figures is also treated as the Total
row, and a warning says so.

## Value formats

| Value | Read as |
| --- | --- |
| Empty, `-`, `–`, `—`, `n/a` | blank (missing), never zero |
| `1512`, `8.232`, `1.41`, `12%` | numbers; a trailing `%` is removed |
| `1,234` in a decimal-point file | 1234, with a warning |
| `12,5` in a decimal-comma file; `1.250` there | 12.5; 1250, with a warning |
| A file with both `0.5`-style and `0,5`-style decimals | those cells left blank, with a warning |
| `0:01:02`, `1:05`, `1:02:03` | durations in seconds (62, 65, 3723) |
| `Duration`/`Tempoh` as plain numbers | seconds |
| `Nov 2, 2026`, `2 Okt 2026`, `2026-11-02` | dates; English and Malay month names |
| `03/04/2026` | blank, warned (day and month order unknown); `25/04/2026` is unambiguous |
| UTF-8 (with or without BOM), UTF-16 with BOM | read; anything else is read as Windows-1252 with a warning |
| Comma, semicolon or tab separators | detected from the header line |
