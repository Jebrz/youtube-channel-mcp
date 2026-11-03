/**
 * Report catalog for the YouTube Analytics API v2 (reports.query) channel reports.
 *
 * Every dimension/metric/filter combination below was checked against the
 * official "Channel Reports" documentation and revision history:
 *   https://developers.google.com/youtube/analytics/channel_reports
 *   https://developers.google.com/youtube/analytics/revision_history
 * (checked 2026-11-03; see docs/ANALYTICS.md for the mapping and caveats).
 *
 * Deliberately NOT offered even though still listed in the docs:
 * - annotation* metrics: YouTube removed annotations in 2019; they only return zeros.
 * - uniques: legacy metric, inconsistently supported.
 * - redViews / estimatedRedMinutesWatched / estimatedRedPartnerRevenue: Premium-only
 *   subsets; available but rarely useful. They are accepted if requested explicitly.
 */

export const MONETARY_METRICS = new Set([
  "estimatedRevenue",
  "estimatedAdRevenue",
  "grossRevenue",
  "estimatedRedPartnerRevenue",
  "monetizedPlaybacks",
  "playbackBasedCpm",
  "adImpressions",
  "cpm",
]);

/** Metrics allowed in the basic stats / time-based / country / top-videos channel reports. */
const CORE_METRICS = [
  "engagedViews",
  "views",
  "redViews",
  "comments",
  "likes",
  "dislikes",
  "videosAddedToPlaylists",
  "videosRemovedFromPlaylists",
  "shares",
  "estimatedMinutesWatched",
  "estimatedRedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "cardClickRate",
  "cardTeaserClickRate",
  "cardImpressions",
  "cardTeaserImpressions",
  "cardClicks",
  "cardTeaserClicks",
  "subscribersGained",
  "subscribersLost",
  ...MONETARY_METRICS,
];

const VIEW_METRICS = ["engagedViews", "views", "estimatedMinutesWatched"];

const DEFAULT_CORE = [
  "views",
  "engagedViews",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "likes",
  "comments",
  "shares",
  "subscribersGained",
  "subscribersLost",
];

export type ReportScope = "channel" | "video";

export interface ReportDef {
  id: string;
  description: string;
  dimensions: string[];
  allowedMetrics: string[];
  defaultMetrics: string[];
  /** Which tools offer the report. */
  scopes: ReportScope[];
  /** Is the report keyed by a time dimension? (affects comparison joins and sorting) */
  timeDimension?: "day" | "month";
  /** Report requires sort + maxResults (top videos). */
  requiresSortAndMax?: { allowedSorts: string[]; defaultSort: string; maxResultsLimit: number };
  notes?: string[];
}

export const REPORTS: Record<string, ReportDef> = {
  summary: {
    id: "summary",
    description: "Totals for the date range (no dimensions). Docs: 'Basic user activity statistics'.",
    dimensions: [],
    allowedMetrics: CORE_METRICS,
    defaultMetrics: DEFAULT_CORE,
    scopes: ["channel", "video"],
  },
  daily: {
    id: "daily",
    description: "One row per day. Docs: 'User activity by country for specific time periods' (day).",
    dimensions: ["day"],
    allowedMetrics: CORE_METRICS,
    defaultMetrics: DEFAULT_CORE,
    scopes: ["channel", "video"],
    timeDimension: "day",
  },
  monthly: {
    id: "monthly",
    description: "One row per calendar month. Docs: time-based report (month). Range must start on the 1st and end on a month's last day.",
    dimensions: ["month"],
    allowedMetrics: CORE_METRICS,
    defaultMetrics: DEFAULT_CORE,
    scopes: ["channel", "video"],
    timeDimension: "month",
  },
  country: {
    id: "country",
    description: "One row per viewer country. Docs: 'User activity by country'.",
    dimensions: ["country"],
    allowedMetrics: CORE_METRICS,
    defaultMetrics: ["views", "engagedViews", "estimatedMinutesWatched", "averageViewDuration", "subscribersGained"],
    scopes: ["channel", "video"],
  },
  traffic_source: {
    id: "traffic_source",
    description: "Views by how viewers found the content. Docs: 'Traffic source' (insightTrafficSourceType).",
    dimensions: ["insightTrafficSourceType"],
    allowedMetrics: VIEW_METRICS,
    defaultMetrics: VIEW_METRICS,
    scopes: ["channel", "video"],
    notes: ["Errors if (# videos queried) x (# days) exceeds 50,000; shorten the range if so."],
  },
  device_type: {
    id: "device_type",
    description: "Views by device type. Docs: 'Device type' (deviceType).",
    dimensions: ["deviceType"],
    allowedMetrics: VIEW_METRICS,
    defaultMetrics: VIEW_METRICS,
    scopes: ["channel", "video"],
  },
  playback_location: {
    id: "playback_location",
    description: "Views by where playback happened. Docs: 'Video playback location report' (insightPlaybackLocationType).",
    dimensions: ["insightPlaybackLocationType"],
    allowedMetrics: VIEW_METRICS,
    defaultMetrics: VIEW_METRICS,
    scopes: ["channel", "video"],
  },
  demographics: {
    id: "demographics",
    description: "Share of viewers by age group and gender. Docs: 'Viewer demographics'.",
    dimensions: ["ageGroup", "gender"],
    allowedMetrics: ["viewerPercentage"],
    defaultMetrics: ["viewerPercentage"],
    scopes: ["channel", "video"],
    notes: [
      "viewerPercentage is the share of logged-in viewers; YouTube withholds demographic data when audiences are too small, so empty results are common for small channels or short ranges.",
    ],
  },
  sharing_service: {
    id: "sharing_service",
    description: "Shares by platform. Docs: 'Engagement and content sharing' (sharingService).",
    dimensions: ["sharingService"],
    allowedMetrics: ["shares"],
    defaultMetrics: ["shares"],
    scopes: ["channel", "video"],
  },
  top_videos: {
    id: "top_videos",
    description: "The channel's top videos for the range. Docs: 'Top videos' (<= 200 results, sort required).",
    dimensions: ["video"],
    allowedMetrics: CORE_METRICS,
    defaultMetrics: ["views", "estimatedMinutesWatched", "averageViewDuration", "likes", "subscribersGained"],
    scopes: ["channel"],
    requiresSortAndMax: {
      allowedSorts: [
        "views",
        "redViews",
        "estimatedRevenue",
        "estimatedRedPartnerRevenue",
        "estimatedMinutesWatched",
        "estimatedRedMinutesWatched",
        "subscribersGained",
        "subscribersLost",
      ],
      defaultSort: "views",
      maxResultsLimit: 200,
    },
  },
  retention: {
    id: "retention",
    description:
      "Audience retention curve for ONE video, by elapsedVideoTimeRatio (0.01-1.0). Docs: 'Audience retention'.",
    dimensions: ["elapsedVideoTimeRatio"],
    allowedMetrics: ["audienceWatchRatio", "relativeRetentionPerformance", "startedWatching", "stoppedWatching", "totalSegmentImpressions"],
    defaultMetrics: ["audienceWatchRatio", "relativeRetentionPerformance"],
    scopes: ["video"],
  },
};

export const CHANNEL_REPORT_IDS = Object.values(REPORTS)
  .filter((r) => r.scopes.includes("channel"))
  .map((r) => r.id) as [string, ...string[]];
export const VIDEO_REPORT_IDS = Object.values(REPORTS)
  .filter((r) => r.scopes.includes("video"))
  .map((r) => r.id) as [string, ...string[]];
