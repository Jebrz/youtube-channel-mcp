import { resolveDateRange, type CompareMode, type DatePreset } from "./analytics/dates.js";
import { VIDEO_ID_RE, runReport, type ReportResult, type Row, type YouTubeAnalyticsApi } from "./analytics/query.js";
import { InvalidInputError } from "./errors.js";
import type { VideoResource, YouTubeDataApi } from "./google/youtubeData.js";

export interface ToolDeps {
  data: YouTubeDataApi;
  analytics: YouTubeAnalyticsApi;
  hasScope: (scope: string) => boolean;
  /** Injectable clock for tests. */
  today: () => Date;
}

function toInt(v: string | undefined): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bestThumbnail(t: Record<string, { url?: string }> | undefined): string | null {
  if (!t) return null;
  for (const k of ["maxres", "standard", "high", "medium", "default"]) if (t[k]?.url) return t[k]!.url!;
  return null;
}

/** ISO-8601 duration (PT1H2M3S) -> seconds. Returns null if absent/unparseable. */
export function parseIsoDuration(d: string | undefined): number | null {
  if (!d) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d);
  if (!m) return null;
  const [, days, h, mi, s] = m;
  return Number(days ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0);
}

function summarizeVideo(v: VideoResource, myChannelId?: string) {
  return {
    videoId: v.id,
    title: v.snippet?.title ?? null,
    description: v.snippet?.description ?? null,
    publishedAt: v.snippet?.publishedAt ?? null,
    channelId: v.snippet?.channelId ?? null,
    channelTitle: v.snippet?.channelTitle ?? null,
    ownedByAuthorizedChannel: myChannelId ? v.snippet?.channelId === myChannelId : undefined,
    tags: v.snippet?.tags ?? [],
    categoryId: v.snippet?.categoryId ?? null,
    defaultLanguage: v.snippet?.defaultLanguage ?? null,
    defaultAudioLanguage: v.snippet?.defaultAudioLanguage ?? null,
    liveBroadcastContent: v.snippet?.liveBroadcastContent ?? null,
    thumbnailUrl: bestThumbnail(v.snippet?.thumbnails),
    duration: v.contentDetails?.duration ?? null,
    durationSeconds: parseIsoDuration(v.contentDetails?.duration),
    definition: v.contentDetails?.definition ?? null,
    captionsAvailable: v.contentDetails?.caption === undefined ? null : v.contentDetails.caption === "true",
    privacyStatus: v.status?.privacyStatus ?? null,
    uploadStatus: v.status?.uploadStatus ?? null,
    scheduledPublishAt: v.status?.publishAt ?? null,
    madeForKids: v.status?.madeForKids ?? null,
    license: v.status?.license ?? null,
    // Statistics can be absent (e.g. likes hidden, comments disabled). We keep null rather than 0.
    statistics: {
      viewCount: toInt(v.statistics?.viewCount),
      likeCount: toInt(v.statistics?.likeCount),
      commentCount: toInt(v.statistics?.commentCount),
    },
    liveStreamingDetails: v.liveStreamingDetails ?? null,
    url: `https://www.youtube.com/watch?v=${v.id}`,
  };
}

// ---------------------------------------------------------------------------
// 1. get_channel_overview
// ---------------------------------------------------------------------------
export async function getChannelOverview(deps: ToolDeps) {
  const ch = await deps.data.getMyChannel();
  const hidden = ch.statistics?.hiddenSubscriberCount === true;
  return {
    channel: {
      channelId: ch.id,
      title: ch.snippet?.title ?? null,
      description: ch.snippet?.description ?? null,
      customUrl: ch.snippet?.customUrl ?? null,
      publishedAt: ch.snippet?.publishedAt ?? null,
      country: ch.snippet?.country ?? null,
      thumbnailUrl: bestThumbnail(ch.snippet?.thumbnails),
      privacyStatus: ch.status?.privacyStatus ?? null,
      madeForKids: ch.status?.madeForKids ?? null,
      url: `https://www.youtube.com/channel/${ch.id}`,
    },
    statistics: {
      viewCount: toInt(ch.statistics?.viewCount),
      subscriberCount: hidden ? null : toInt(ch.statistics?.subscriberCount),
      subscriberCountHidden: hidden,
      videoCount: toInt(ch.statistics?.videoCount),
    },
    uploadsPlaylistId: ch.contentDetails?.relatedPlaylists?.uploads ?? null,
    grantedAccess: {
      analytics: deps.hasScope("https://www.googleapis.com/auth/yt-analytics.readonly"),
      monetaryAnalytics: deps.hasScope("https://www.googleapis.com/auth/yt-analytics-monetary.readonly"),
    },
    notes: [
      "subscriberCount from the Data API is rounded down to three significant figures by YouTube.",
      "Lifetime counts come from the YouTube Data API and can differ slightly from YouTube Analytics totals.",
    ],
    source: "YouTube Data API v3 channels.list (mine=true, 1 quota unit)",
    retrievedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 2. list_videos
// ---------------------------------------------------------------------------
export interface ListVideosInput {
  max_results?: number;
  page_token?: string;
  include_details?: boolean;
}

export async function listVideos(deps: ToolDeps, input: ListVideosInput) {
  const maxResults = input.max_results ?? 25;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
    throw new InvalidInputError("max_results must be an integer between 1 and 50.");
  }
  const includeDetails = input.include_details ?? true;
  const ch = await deps.data.getMyChannel();
  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  const notes: string[] = [];
  if (!uploads) {
    return {
      channelId: ch.id,
      videos: [],
      pageInfo: { returned: 0, totalResults: 0, nextPageToken: null, prevPageToken: null, hasMore: false },
      notes: ["This channel has no uploads playlist, so it has no uploaded videos."],
    };
  }
  const page = await deps.data.listUploadsPage(uploads, { pageToken: input.page_token, maxResults });
  if (page.playlistMissing) notes.push("The channel's uploads playlist was not found; the channel has no uploaded videos.");

  let detailsById = new Map<string, VideoResource>();
  const ids = page.items.map((i) => i.contentDetails?.videoId).filter((x): x is string => Boolean(x));
  if (includeDetails && ids.length) {
    const vids = await deps.data.getVideos(ids);
    detailsById = new Map(vids.map((v) => [v.id, v]));
  }

  const videos = page.items.map((item) => {
    const id = item.contentDetails?.videoId ?? null;
    const base = {
      videoId: id,
      title: item.snippet?.title ?? null,
      publishedAt: item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt ?? null,
      privacyStatus: item.status?.privacyStatus ?? null,
    };
    if (!includeDetails || !id) return base;
    const v = detailsById.get(id);
    if (!v) return { ...base, details: null, detailsUnavailableReason: "videos.list returned no data for this ID (deleted, rejected, or not accessible)." };
    const s = summarizeVideo(v);
    return {
      ...base,
      duration: s.duration,
      durationSeconds: s.durationSeconds,
      privacyStatus: s.privacyStatus ?? base.privacyStatus,
      statistics: s.statistics,
    };
  });

  if (videos.length === 0 && !page.playlistMissing) {
    notes.push(input.page_token ? "This page is empty (end of list)." : "The channel has no uploaded videos.");
  }
  notes.push("Videos are listed from the channel's uploads playlist (newest first). Use page_token with nextPageToken to get more.");

  return {
    channelId: ch.id,
    videos,
    pageInfo: {
      returned: videos.length,
      totalResults: page.totalResults ?? null,
      nextPageToken: page.nextPageToken ?? null,
      prevPageToken: page.prevPageToken ?? null,
      hasMore: Boolean(page.nextPageToken),
    },
    notes,
    source: `YouTube Data API v3 playlistItems.list (1 unit)${includeDetails && ids.length ? " + videos.list (1 unit)" : ""}`,
  };
}

// ---------------------------------------------------------------------------
// 3. get_video_details
// ---------------------------------------------------------------------------
export async function getVideoDetails(deps: ToolDeps, input: { video_ids: string[] }) {
  const ids = [...new Set(input.video_ids.map((s) => s.trim()))];
  if (ids.length === 0 || ids.length > 50) throw new InvalidInputError("Provide between 1 and 50 video_ids.");
  const bad = ids.filter((id) => !VIDEO_ID_RE.test(id));
  if (bad.length) throw new InvalidInputError(`Invalid video ID(s): ${bad.join(", ")}. A video ID is the 11-character value after "v=" in a YouTube URL.`);

  const [ch, vids] = await Promise.all([deps.data.getMyChannel(), deps.data.getVideos(ids)]);
  const found = new Set(vids.map((v) => v.id));
  const notFound = ids.filter((id) => !found.has(id));
  const videos = vids.map((v) => summarizeVideo(v, ch.id));
  const notes: string[] = [];
  if (notFound.length) notes.push(`No data returned for: ${notFound.join(", ")} (deleted, private to another account, or never existed).`);
  if (videos.some((v) => v.ownedByAuthorizedChannel === false)) {
    notes.push("Some videos belong to other channels: only public metadata is shown, and analytics are not available for them.");
  }
  return {
    videos,
    notFound,
    notes,
    source: "YouTube Data API v3 videos.list (1 unit per 50 IDs) + channels.list (1 unit)",
  };
}

// ---------------------------------------------------------------------------
// 4 & 5. get_channel_analytics / get_video_analytics
// ---------------------------------------------------------------------------
export interface AnalyticsInput {
  report?: string;
  preset?: DatePreset;
  start_date?: string;
  end_date?: string;
  compare?: CompareMode;
  compare_start_date?: string;
  compare_end_date?: string;
  metrics?: string[];
  sort?: string;
  max_results?: number;
  start_index?: number;
  currency?: string;
}

function compareRangeFromInput(input: AnalyticsInput) {
  if ((input.compare_start_date || input.compare_end_date) && input.compare !== "custom") {
    throw new InvalidInputError("compare_start_date/compare_end_date are only used with compare=custom.");
  }
  if (input.compare === "custom") {
    if (!input.compare_start_date || !input.compare_end_date) {
      throw new InvalidInputError("compare=custom requires both compare_start_date and compare_end_date.");
    }
    return { startDate: input.compare_start_date, endDate: input.compare_end_date };
  }
  return undefined;
}

export async function getChannelAnalytics(deps: ToolDeps, input: AnalyticsInput) {
  const range = resolveDateRange(input, deps.today());
  const result = await runReport(
    deps.analytics,
    {
      scope: "channel",
      reportId: input.report ?? "summary",
      range,
      compare: input.compare ?? "none",
      compareRange: compareRangeFromInput(input),
      metrics: input.metrics,
      sort: input.sort,
      maxResults: input.max_results,
      startIndex: input.start_index,
      currency: input.currency,
    },
    { hasScope: deps.hasScope },
  );
  if (result.report === "top_videos") await addVideoTitles(deps, result);
  return result;
}

export async function getVideoAnalytics(deps: ToolDeps, input: AnalyticsInput & { video_id: string }) {
  const range = resolveDateRange(input, deps.today());
  return runReport(
    deps.analytics,
    {
      scope: "video",
      reportId: input.report ?? "summary",
      range,
      compare: input.compare ?? "none",
      compareRange: compareRangeFromInput(input),
      metrics: input.metrics,
      videoId: input.video_id?.trim(),
      currency: input.currency,
    },
    { hasScope: deps.hasScope },
  );
}

/** Attach video titles to top_videos rows (1 Data API unit per 50 videos). Titles never replace missing data. */
async function addVideoTitles(deps: ToolDeps, result: ReportResult): Promise<void> {
  const rowsets: Row[][] = [result.rows, result.comparison?.rows ?? []];
  const ids = [...new Set(rowsets.flat().map((r) => r.video).filter((x): x is string => typeof x === "string"))];
  if (!ids.length) return;
  try {
    const vids = await deps.data.getVideos(ids);
    const titles = new Map(vids.map((v) => [v.id, v.snippet?.title ?? null]));
    for (const rows of rowsets) for (const r of rows) if (typeof r.video === "string") r.title = titles.get(r.video) ?? null;
  } catch (e) {
    result.notes.push(`Could not look up video titles: ${(e as Error).message}`);
  }
}
