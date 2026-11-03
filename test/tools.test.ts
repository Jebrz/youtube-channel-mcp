import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPES } from "../src/config.js";
import { AuthRequiredError, InvalidInputError } from "../src/errors.js";
import { getChannelAnalytics, getChannelOverview, getVideoAnalytics, getVideoDetails, listVideos, parseIsoDuration } from "../src/tools.js";
import {
  CHANNEL_ID,
  StaticToken,
  UPLOADS_ID,
  analyticsResponse,
  channelResponse,
  googleError,
  json,
  makeDeps,
  mockFetch,
  playlistItem,
  video,
  type Handler,
} from "./helpers.js";

beforeEach(() => void vi.spyOn(process.stderr, "write").mockImplementation(() => true));
afterEach(() => vi.restoreAllMocks());

const channels: Handler = (u) => (u.pathname.endsWith("/channels") ? json(200, channelResponse()) : undefined);
const isAnalytics = (u: URL) => u.hostname === "youtubeanalytics.googleapis.com";

describe("get_channel_overview", () => {
  it("returns channel profile and numeric statistics", async () => {
    const f = mockFetch(channels);
    const out = await getChannelOverview(makeDeps(f));
    expect(out.channel).toMatchObject({ channelId: CHANNEL_ID, title: "Test Channel", customUrl: "@testchannel", thumbnailUrl: "https://yt3.example/high.jpg" });
    expect(out.statistics).toEqual({ viewCount: 123456, subscriberCount: 1230, subscriberCountHidden: false, videoCount: 3 });
    expect(f.calls[0]!.url.searchParams.get("mine")).toBe("true");
  });

  it("returns null (not 0) for hidden subscriber counts", async () => {
    const f = mockFetch(() => json(200, channelResponse({ statistics: { viewCount: "5", hiddenSubscriberCount: true, videoCount: "1" } })));
    const out = await getChannelOverview(makeDeps(f));
    expect(out.statistics.subscriberCount).toBeNull();
    expect(out.statistics.subscriberCountHidden).toBe(true);
  });

  it("reports an account without a channel instead of inventing one", async () => {
    const f = mockFetch(() => json(200, { items: [] }));
    await expect(getChannelOverview(makeDeps(f))).rejects.toMatchObject({ code: "NO_CHANNEL" });
  });
});

describe("list_videos", () => {
  it("lists uploads with details and passes pagination tokens through", async () => {
    const f = mockFetch(
      channels,
      (u) =>
        u.pathname.endsWith("/playlistItems")
          ? json(200, {
              items: [playlistItem("aaaaaaaaaaa", "Newest", "2026-10-01T00:00:00Z"), playlistItem("bbbbbbbbbbb", "Older", "2026-09-01T00:00:00Z", "unlisted")],
              nextPageToken: "NEXT",
              prevPageToken: "PREV",
              pageInfo: { totalResults: 3, resultsPerPage: 2 },
            })
          : undefined,
      (u) => (u.pathname.endsWith("/videos") ? json(200, { items: [video("aaaaaaaaaaa", "Newest")] }) : undefined),
    );
    const out = await listVideos(makeDeps(f), { max_results: 2, page_token: "TOKEN1" });
    const pl = f.calls.find((c) => c.url.pathname.endsWith("/playlistItems"))!.url;
    expect(pl.searchParams.get("playlistId")).toBe(UPLOADS_ID);
    expect(pl.searchParams.get("pageToken")).toBe("TOKEN1");
    expect(pl.searchParams.get("maxResults")).toBe("2");
    expect(out.pageInfo).toEqual({ returned: 2, totalResults: 3, nextPageToken: "NEXT", prevPageToken: "PREV", hasMore: true });
    expect(out.videos[0]).toMatchObject({ videoId: "aaaaaaaaaaa", durationSeconds: 253, statistics: { viewCount: 100, likeCount: 10, commentCount: 2 } });
    // Video missing from videos.list is flagged, never filled with fake numbers.
    expect(out.videos[1]).toMatchObject({ videoId: "bbbbbbbbbbb", details: null, privacyStatus: "unlisted" });
    expect(out.videos[1]).not.toHaveProperty("statistics");
  });

  it("follows pages until there is no nextPageToken", async () => {
    const pages: Record<string, unknown> = {
      "": { items: [playlistItem("aaaaaaaaaaa", "A", "2026-01-02T00:00:00Z")], nextPageToken: "P2" },
      P2: { items: [playlistItem("bbbbbbbbbbb", "B", "2026-01-01T00:00:00Z")] },
    };
    const f = mockFetch(channels, (u) => (u.pathname.endsWith("/playlistItems") ? json(200, pages[u.searchParams.get("pageToken") ?? ""]) : undefined));
    const deps = makeDeps(f);
    const p1 = await listVideos(deps, { include_details: false });
    const p2 = await listVideos(deps, { include_details: false, page_token: p1.pageInfo.nextPageToken! });
    expect([...p1.videos, ...p2.videos].map((v) => v.videoId)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
    expect(p2.pageInfo.hasMore).toBe(false);
    expect(f.calls.some((c) => c.url.pathname.endsWith("/videos"))).toBe(false);
  });

  it("handles a channel with no uploads (empty and 404 playlist)", async () => {
    const empty = mockFetch(channels, (u) => (u.pathname.endsWith("/playlistItems") ? json(200, { items: [], pageInfo: { totalResults: 0 } }) : undefined));
    const a = await listVideos(makeDeps(empty), {});
    expect(a.videos).toEqual([]);
    expect(a.notes.join(" ")).toMatch(/no uploaded videos/);

    const missing = mockFetch(channels, (u) => (u.pathname.endsWith("/playlistItems") ? googleError(404, "playlistNotFound", "not found") : undefined));
    const b = await listVideos(makeDeps(missing), {});
    expect(b.videos).toEqual([]);
  });

  it("validates max_results", async () => {
    await expect(listVideos(makeDeps(mockFetch()), { max_results: 51 })).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("get_video_details", () => {
  it("returns details, flags ownership, and lists IDs with no data", async () => {
    const f = mockFetch(channels, (u) =>
      u.pathname.endsWith("/videos")
        ? json(200, { items: [video("aaaaaaaaaaa", "Mine"), video("ccccccccccc", "Theirs", "UCsomeoneelse000000000", { viewCount: "5" })] })
        : undefined,
    );
    const out = await getVideoDetails(makeDeps(f), { video_ids: ["aaaaaaaaaaa", "ccccccccccc", "zzzzzzzzzzz"] });
    expect(out.notFound).toEqual(["zzzzzzzzzzz"]);
    expect(out.videos.map((v) => v.ownedByAuthorizedChannel)).toEqual([true, false]);
    // likeCount absent in API response -> null, not 0
    expect(out.videos[1]!.statistics).toEqual({ viewCount: 5, likeCount: null, commentCount: null });
  });

  it("rejects malformed IDs before calling the API", async () => {
    const f = mockFetch();
    await expect(getVideoDetails(makeDeps(f), { video_ids: ["https://youtu.be/x"] })).rejects.toBeInstanceOf(InvalidInputError);
    expect(f.calls).toHaveLength(0);
  });

  it("parses ISO durations", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("P1DT1S")).toBe(86401);
    expect(parseIsoDuration("P0D")).toBe(0);
    expect(parseIsoDuration(undefined)).toBeNull();
  });
});

describe("get_channel_analytics", () => {
  const summaryCols: Array<[string, "METRIC", string]> = [
    ["views", "METRIC", "INTEGER"],
    ["estimatedMinutesWatched", "METRIC", "INTEGER"],
  ];

  it("runs a summary with previous_period comparison and computes changes", async () => {
    const f = mockFetch((u) => {
      if (!isAnalytics(u)) return undefined;
      const start = u.searchParams.get("startDate");
      return json(200, analyticsResponse(summaryCols, start === "2026-10-05" ? [[1500, 3000]] : [[1000, 3000]]));
    });
    const out = await getChannelAnalytics(makeDeps(f), { metrics: ["views", "estimatedMinutesWatched"], compare: "previous_period" });
    const qs = f.calls.map((c) => c.url.searchParams);
    expect(qs.map((q) => [q.get("startDate"), q.get("endDate")])).toEqual([
      ["2026-10-05", "2026-11-01"],
      ["2026-09-07", "2026-10-04"],
    ]);
    expect(qs[0]!.get("ids")).toBe("channel==MINE");
    expect(qs[0]!.get("metrics")).toBe("views,estimatedMinutesWatched");
    expect(qs[0]!.has("dimensions")).toBe(false);
    expect(out.rows).toEqual([{ views: 1500, estimatedMinutesWatched: 3000 }]);
    expect(out.comparison!.changes).toEqual({
      views: { current: 1500, previous: 1000, absoluteChange: 500, percentChange: 50 },
      estimatedMinutesWatched: { current: 3000, previous: 3000, absoluteChange: 0, percentChange: 0 },
    });
  });

  it("returns empty results honestly (no zeros invented)", async () => {
    const f = mockFetch((u) => (isAnalytics(u) ? json(200, analyticsResponse(summaryCols, undefined)) : undefined));
    const out = await getChannelAnalytics(makeDeps(f), { metrics: ["views", "estimatedMinutesWatched"], compare: "previous_year" });
    expect(out.rows).toEqual([]);
    expect(out.rowCount).toBe(0);
    expect(out.notes.join(" ")).toMatch(/returned no rows/);
    expect(out.comparison!.changes).toEqual({
      views: { current: null, previous: null, absoluteChange: null, percentChange: null },
      estimatedMinutesWatched: { current: null, previous: null, absoluteChange: null, percentChange: null },
    });
  });

  it("percentChange is null when the previous value is 0", async () => {
    const f = mockFetch((u) =>
      isAnalytics(u) ? json(200, analyticsResponse([["views", "METRIC", "INTEGER"]], u.searchParams.get("startDate") === "2026-10-05" ? [[10]] : [[0]])) : undefined,
    );
    const out = await getChannelAnalytics(makeDeps(f), { metrics: ["views"], compare: "previous_period" });
    expect((out.comparison!.changes as Record<string, unknown>).views).toEqual({ current: 10, previous: 0, absoluteChange: 10, percentChange: null });
  });

  it("joins dimensional reports by key and keeps missing keys as null", async () => {
    const cols: Array<[string, "DIMENSION" | "METRIC", string]> = [
      ["insightTrafficSourceType", "DIMENSION", "STRING"],
      ["views", "METRIC", "INTEGER"],
    ];
    const f = mockFetch((u) => {
      if (!isAnalytics(u)) return undefined;
      return u.searchParams.get("startDate") === "2026-10-05"
        ? json(200, analyticsResponse(cols, [["YT_SEARCH", 50], ["SUBSCRIBER", 80]]))
        : json(200, analyticsResponse(cols, [["YT_SEARCH", 40], ["EXT_URL", 5]]));
    });
    const out = await getChannelAnalytics(makeDeps(f), { report: "traffic_source", metrics: ["views"], compare: "previous_period" });
    expect(f.calls[0]!.url.searchParams.get("dimensions")).toBe("insightTrafficSourceType");
    expect(out.rows.map((r) => r.insightTrafficSourceType)).toEqual(["SUBSCRIBER", "YT_SEARCH"]); // sorted by views desc
    const changes = out.comparison!.changes as Array<{ key: Record<string, string>; metrics: Record<string, { current: number | null; previous: number | null }> }>;
    const byKey = Object.fromEntries(changes.map((c) => [c.key.insightTrafficSourceType, c.metrics.views]));
    expect(byKey.SUBSCRIBER).toMatchObject({ current: 80, previous: null });
    expect(byKey.EXT_URL).toMatchObject({ current: null, previous: 5 });
    expect(byKey.YT_SEARCH).toMatchObject({ current: 50, previous: 40, percentChange: 25 });
  });

  it("rejects metrics not supported by the chosen report (no API call)", async () => {
    const f = mockFetch();
    const err = await getChannelAnalytics(makeDeps(f), { report: "traffic_source", metrics: ["likes"] }).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidInputError);
    expect(err.hint).toMatch(/engagedViews, views, estimatedMinutesWatched/);
    expect(f.calls).toHaveLength(0);
  });

  it("requires the monetary scope for revenue metrics (no API call)", async () => {
    const f = mockFetch();
    await expect(getChannelAnalytics(makeDeps(f), { metrics: ["estimatedRevenue"] })).rejects.toBeInstanceOf(AuthRequiredError);
    expect(f.calls).toHaveLength(0);
  });

  it("allows revenue metrics with the monetary scope and passes currency", async () => {
    const f = mockFetch((u) => (isAnalytics(u) ? json(200, analyticsResponse([["estimatedRevenue", "METRIC", "FLOAT"]], [[12.5]])) : undefined));
    const auth = new StaticToken([SCOPES.youtubeReadonly, SCOPES.analyticsReadonly, SCOPES.analyticsMonetaryReadonly]);
    const out = await getChannelAnalytics(makeDeps(f, auth), { metrics: ["estimatedRevenue"], currency: "EUR" });
    expect(f.calls[0]!.url.searchParams.get("currency")).toBe("EUR");
    expect(out.rows[0]!.estimatedRevenue).toBe(12.5);
  });

  it("monthly report requires whole-month ranges", async () => {
    const f = mockFetch((u) => (isAnalytics(u) ? json(200, analyticsResponse([["month", "DIMENSION", "STRING"], ["views", "METRIC", "INTEGER"]], [["2026-10", 9]])) : undefined));
    await expect(getChannelAnalytics(makeDeps(f), { report: "monthly" })).rejects.toThrow(/starts on the 1st/);
    const ok = await getChannelAnalytics(makeDeps(f), { report: "monthly", preset: "last_month", metrics: ["views"], compare: "previous_year" });
    expect(ok.comparison!.dateRange).toEqual({ startDate: "2025-10-01", endDate: "2025-10-31" });
    expect(ok.comparison!.changes).toBeUndefined(); // time series are returned side by side
  });

  it("top_videos sends required sort/maxResults and adds titles", async () => {
    const f = mockFetch(
      (u) =>
        isAnalytics(u)
          ? json(200, analyticsResponse([["video", "DIMENSION", "STRING"], ["views", "METRIC", "INTEGER"], ["estimatedMinutesWatched", "METRIC", "INTEGER"]], [["aaaaaaaaaaa", 900, 50], ["bbbbbbbbbbb", 100, 5]]))
          : undefined,
      (u) => (u.pathname.endsWith("/videos") ? json(200, { items: [video("aaaaaaaaaaa", "Hit")] }) : undefined),
    );
    const out = await getChannelAnalytics(makeDeps(f), { report: "top_videos", metrics: ["estimatedMinutesWatched"], max_results: 10 });
    const q = f.calls.find((c) => isAnalytics(c.url))!.url.searchParams;
    expect(q.get("sort")).toBe("-views");
    expect(q.get("maxResults")).toBe("10");
    expect(q.get("metrics")).toBe("estimatedMinutesWatched,views");
    expect(out.rows.map((r) => r.title)).toEqual(["Hit", null]);
  });

  it("top_videos rejects unsupported sorts and too many results", async () => {
    await expect(getChannelAnalytics(makeDeps(mockFetch()), { report: "top_videos", sort: "likes" })).rejects.toThrow(/not supported/);
    await expect(getChannelAnalytics(makeDeps(mockFetch()), { report: "top_videos", max_results: 500 })).rejects.toThrow(/between 1 and 200/);
  });

  it("surfaces an API 'query not supported' as METRIC_UNAVAILABLE", async () => {
    const f = mockFetch(() => googleError(400, "badRequest", "The query is not supported."));
    await expect(getChannelAnalytics(makeDeps(f), {})).rejects.toMatchObject({ code: "METRIC_UNAVAILABLE" });
  });
});

describe("get_video_analytics", () => {
  it("filters by video and supports the retention report", async () => {
    const f = mockFetch((u) =>
      isAnalytics(u)
        ? json(
            200,
            analyticsResponse(
              [["elapsedVideoTimeRatio", "DIMENSION", "FLOAT"], ["audienceWatchRatio", "METRIC", "FLOAT"], ["relativeRetentionPerformance", "METRIC", "FLOAT"]],
              [[0.1, 0.8, 0.5], [0.01, 1.0, 0.6], [0.02, 0.95, 0.55]],
            ),
          )
        : undefined,
    );
    const out = await getVideoAnalytics(makeDeps(f), { video_id: "aaaaaaaaaaa", report: "retention", preset: "last_90_days" });
    const q = f.calls[0]!.url.searchParams;
    expect(q.get("filters")).toBe("video==aaaaaaaaaaa");
    expect(q.get("dimensions")).toBe("elapsedVideoTimeRatio");
    expect(out.rows.map((r) => r.elapsedVideoTimeRatio)).toEqual([0.01, 0.02, 0.1]);
  });

  it("validates the video id and rejects channel-only reports", async () => {
    await expect(getVideoAnalytics(makeDeps(mockFetch()), { video_id: "bad" })).rejects.toThrow(/11-character/);
    await expect(getVideoAnalytics(makeDeps(mockFetch()), { video_id: "aaaaaaaaaaa", report: "top_videos" })).rejects.toThrow(/Unknown report/);
  });

  it("supports custom comparison ranges", async () => {
    const f = mockFetch((u) => (isAnalytics(u) ? json(200, analyticsResponse([["views", "METRIC", "INTEGER"]], [[7]])) : undefined));
    const out = await getVideoAnalytics(makeDeps(f), {
      video_id: "aaaaaaaaaaa",
      start_date: "2026-06-01",
      end_date: "2026-06-07",
      compare: "custom",
      compare_start_date: "2026-05-01",
      compare_end_date: "2026-05-07",
      metrics: ["views"],
    });
    expect(out.comparison!.dateRange).toEqual({ startDate: "2026-05-01", endDate: "2026-05-07" });
    await expect(getVideoAnalytics(makeDeps(f), { video_id: "aaaaaaaaaaa", compare: "custom" })).rejects.toThrow(/requires both/);
  });
});
