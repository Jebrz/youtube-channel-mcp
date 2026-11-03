/**
 * Test helpers. Every test in this directory uses MOCKED HTTP responses only;
 * nothing here talks to Google. Live validation is `npm run live-check`.
 */
import { YouTubeAnalyticsApi } from "../src/analytics/query.js";
import type { AccessTokenProvider, FetchLike } from "../src/auth/manager.js";
import { GoogleClient } from "../src/google/client.js";
import { YouTubeDataApi } from "../src/google/youtubeData.js";
import type { ToolDeps } from "../src/tools.js";
import { SCOPES } from "../src/config.js";

export interface RecordedCall {
  url: URL;
  init?: RequestInit;
}

export type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function googleError(status: number, reason: string, message: string): Response {
  return json(status, { error: { code: status, message, errors: [{ reason, message, domain: "youtube" }] } });
}

/** A fetch mock that dispatches to handlers in order and records every call. */
export function mockFetch(...handlers: Handler[]): FetchLike & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    for (const h of handlers) {
      const r = await h(url, init);
      if (r) return r;
    }
    throw new Error(`Unmocked request: ${url.toString()}`);
  }) as FetchLike & { calls: RecordedCall[] };
  fn.calls = calls;
  return fn;
}

/** A sequence of responses for a path, consumed one per call. */
export function sequence(pathIncludes: string, responses: Array<() => Response>): Handler {
  let i = 0;
  return (url) => {
    if (!url.pathname.includes(pathIncludes)) return undefined;
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return r();
  };
}

export class StaticToken implements AccessTokenProvider {
  invalidations = 0;
  constructor(
    private scopes: string[] = [SCOPES.youtubeReadonly, SCOPES.analyticsReadonly],
    private token = "ya29.test-token",
  ) {}
  async getAccessToken() {
    return this.token;
  }
  invalidate() {
    this.invalidations++;
  }
  hasScope(s: string) {
    return this.scopes.includes(s);
  }
}

export const TODAY = new Date("2026-11-03T12:00:00Z");

export function makeDeps(fetchImpl: FetchLike, auth: AccessTokenProvider = new StaticToken()): ToolDeps {
  const client = new GoogleClient(auth, { fetchImpl, sleep: async () => {}, maxRetries: 2 });
  return {
    data: new YouTubeDataApi(client),
    analytics: new YouTubeAnalyticsApi(client),
    hasScope: (s) => auth.hasScope(s),
    today: () => TODAY,
  };
}

// ---------------------------------------------------------------------------
// Fixtures shaped like real API responses (values are fake).
// ---------------------------------------------------------------------------
export const CHANNEL_ID = "UCabcdefghijklmnopqrstuv";
export const UPLOADS_ID = "UUabcdefghijklmnopqrstuv";

export const channelResponse = (overrides: Record<string, unknown> = {}) => ({
  kind: "youtube#channelListResponse",
  pageInfo: { totalResults: 1, resultsPerPage: 1 },
  items: [
    {
      kind: "youtube#channel",
      id: CHANNEL_ID,
      snippet: {
        title: "Test Channel",
        description: "A channel used in tests",
        customUrl: "@testchannel",
        publishedAt: "2015-01-01T00:00:00Z",
        country: "US",
        thumbnails: { default: { url: "https://yt3.example/default.jpg" }, high: { url: "https://yt3.example/high.jpg" } },
      },
      contentDetails: { relatedPlaylists: { uploads: UPLOADS_ID, likes: "" } },
      statistics: { viewCount: "123456", subscriberCount: "1230", hiddenSubscriberCount: false, videoCount: "3" },
      status: { privacyStatus: "public", isLinked: true, madeForKids: false },
      ...overrides,
    },
  ],
});

export const playlistItem = (videoId: string, title: string, publishedAt: string, privacy = "public") => ({
  kind: "youtube#playlistItem",
  id: `PLI_${videoId}`,
  snippet: { title, publishedAt, channelId: CHANNEL_ID },
  contentDetails: { videoId, videoPublishedAt: publishedAt },
  status: { privacyStatus: privacy },
});

export const video = (id: string, title: string, channelId = CHANNEL_ID, stats: Record<string, string> = { viewCount: "100", likeCount: "10", commentCount: "2" }) => ({
  kind: "youtube#video",
  id,
  snippet: { title, description: `About ${title}`, publishedAt: "2026-01-01T00:00:00Z", channelId, channelTitle: "Test Channel", tags: ["t"], categoryId: "22" },
  contentDetails: { duration: "PT4M13S", definition: "hd", caption: "false" },
  statistics: stats,
  status: { uploadStatus: "processed", privacyStatus: "public", license: "youtube", madeForKids: false },
});

export function analyticsResponse(columns: Array<[string, "DIMENSION" | "METRIC", string]>, rows: Array<Array<string | number>> | undefined) {
  return {
    kind: "youtubeAnalytics#resultTable",
    columnHeaders: columns.map(([name, columnType, dataType]) => ({ name, columnType, dataType })),
    ...(rows ? { rows } : {}),
  };
}
