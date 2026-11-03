import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { COMPARE_MODES, DATE_PRESETS } from "./analytics/dates.js";
import { CHANNEL_REPORT_IDS, REPORTS, VIDEO_REPORT_IDS } from "./analytics/reports.js";
import { errorToToolPayload } from "./errors.js";
import { log } from "./redact.js";
import { getChannelAnalytics, getChannelOverview, getVideoAnalytics, getVideoDetails, listVideos, type ToolDeps } from "./tools.js";

export const SERVER_NAME = "youtube-channel-mcp";
export const SERVER_VERSION = "0.1.0";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

async function wrap(name: string, fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    const payload = errorToToolPayload(err);
    log.warn(`Tool ${name} failed: ${payload.error.code}: ${payload.error.message}`);
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
  }
}

function reportHelp(ids: readonly string[]): string {
  return ids.map((id) => `- ${id}: ${REPORTS[id]!.description} Metrics: ${REPORTS[id]!.allowedMetrics.filter((m) => !m.startsWith("estimatedRed") && m !== "redViews").join(", ")}.`).join("\n");
}

const dateShape = {
  preset: z.enum(DATE_PRESETS).optional().describe("Relative date range. Defaults to last_28_days. Presets end 2 days before today (data latency)."),
  start_date: z.string().optional().describe("Custom start date YYYY-MM-DD (use with end_date instead of preset)."),
  end_date: z.string().optional().describe("Custom end date YYYY-MM-DD, inclusive."),
  compare: z
    .enum(COMPARE_MODES)
    .optional()
    .describe("Comparison period: none (default), previous_period (same length immediately before), previous_year (same dates last year), custom."),
  compare_start_date: z.string().optional().describe("Comparison start date YYYY-MM-DD (compare=custom only)."),
  compare_end_date: z.string().optional().describe("Comparison end date YYYY-MM-DD (compare=custom only)."),
  metrics: z.array(z.string()).optional().describe("Metrics to return. Omit for sensible defaults. Must be supported by the chosen report."),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional()
    .describe("ISO 4217 currency for monetary metrics (default USD). Monetary metrics require `auth --monetary`."),
};

export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "get_channel_overview",
    {
      title: "Get channel overview",
      description:
        "Read-only. Returns the authorized YouTube channel's profile (title, description, custom URL, creation date) and lifetime public statistics (views, subscribers, video count) from the YouTube Data API.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => wrap("get_channel_overview", () => getChannelOverview(deps)),
  );

  server.registerTool(
    "list_videos",
    {
      title: "List channel videos",
      description:
        "Read-only. Lists videos uploaded by the authorized channel, newest first, with optional duration and public statistics. Paginated: pass the returned nextPageToken as page_token to get the next page.",
      inputSchema: {
        max_results: z.number().int().min(1).max(50).optional().describe("Videos per page, 1-50 (default 25)."),
        page_token: z.string().optional().describe("nextPageToken / prevPageToken from a previous call."),
        include_details: z.boolean().optional().describe("Include duration and view/like/comment counts (default true, +1 quota unit)."),
      },
      annotations: READ_ONLY,
    },
    (args) => wrap("list_videos", () => listVideos(deps, args)),
  );

  server.registerTool(
    "get_video_details",
    {
      title: "Get video details",
      description:
        "Read-only. Returns metadata (title, description, tags, duration, privacy, captions, publish time) and public statistics for 1-50 video IDs. Reports IDs that returned no data instead of guessing.",
      inputSchema: {
        video_ids: z.array(z.string()).min(1).max(50).describe("YouTube video IDs (11 characters, the value after v= in the URL)."),
      },
      annotations: READ_ONLY,
    },
    (args) => wrap("get_video_details", () => getVideoDetails(deps, args)),
  );

  server.registerTool(
    "get_channel_analytics",
    {
      title: "Get channel analytics",
      description:
        "Read-only. Runs a YouTube Analytics report for the whole authorized channel over a date range, optionally compared with another period. " +
        "Reports:\n" +
        reportHelp(CHANNEL_REPORT_IDS) +
        "\nEmpty results are reported as empty; values are never estimated or filled in.",
      inputSchema: {
        report: z.enum(CHANNEL_REPORT_IDS).optional().describe("Report type (default summary)."),
        ...dateShape,
        sort: z.string().optional().describe("top_videos only: metric to rank by, descending (default views)."),
        max_results: z.number().int().min(1).max(200).optional().describe("top_videos only: number of videos, 1-200 (default 25)."),
        start_index: z.number().int().min(1).optional().describe("top_videos only: 1-based index of the first row, for paging."),
      },
      annotations: READ_ONLY,
    },
    (args) => wrap("get_channel_analytics", () => getChannelAnalytics(deps, args)),
  );

  server.registerTool(
    "get_video_analytics",
    {
      title: "Get video analytics",
      description:
        "Read-only. Runs a YouTube Analytics report for ONE video owned by the authorized channel, optionally compared with another period. " +
        "Reports:\n" +
        reportHelp(VIDEO_REPORT_IDS) +
        "\nEmpty results are reported as empty; values are never estimated or filled in.",
      inputSchema: {
        video_id: z.string().describe("The 11-character YouTube video ID."),
        report: z.enum(VIDEO_REPORT_IDS).optional().describe("Report type (default summary)."),
        ...dateShape,
      },
      annotations: READ_ONLY,
    },
    (args) => wrap("get_video_analytics", () => getVideoAnalytics(deps, args)),
  );

  return server;
}
