import { resolvePreset } from "../analytics/dates.js";
import type { ToolDeps } from "../tools.js";

export interface LiveCheckResult {
  channelId: string;
  channelTitle: string | null;
  videoCount: string | null;
  range: { startDate: string; endDate: string };
  /** First analytics row, or null when YouTube returned no rows (no data yet). */
  analytics: { views: unknown; estimatedMinutesWatched: unknown } | null;
}

export type LiveCheckStep = "channel" | "analytics";

export class LiveCheckError extends Error {
  constructor(
    readonly step: LiveCheckStep,
    readonly error: unknown,
  ) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "LiveCheckError";
  }
}

/**
 * The smallest end-to-end check: read the signed-in channel (Data API, 1 unit)
 * and run one Analytics query (views, last 7 days). Used by `check`,
 * `doctor --live` and `setup`. Makes exactly two read-only Google requests
 * (plus a token refresh if needed).
 */
export async function runLiveCheck(deps: ToolDeps, out: (line: string) => void = () => {}): Promise<LiveCheckResult> {
  out("1/2 Reading channel via YouTube Data API (channels.list mine=true)...");
  let ch;
  try {
    ch = await deps.data.getMyChannel();
  } catch (e) {
    throw new LiveCheckError("channel", e);
  }
  out(`    OK: "${ch.snippet?.title ?? "(untitled)"}" (${ch.id}), ${ch.statistics?.videoCount ?? "?"} videos.`);
  out("2/2 Running a YouTube Analytics query (views, last 7 days)...");
  const range = resolvePreset("last_7_days", deps.today());
  let rows;
  try {
    rows = (await deps.analytics.query({ ...range, metrics: ["views", "estimatedMinutesWatched"], dimensions: [] })).rows;
  } catch (e) {
    throw new LiveCheckError("analytics", e);
  }
  const first = rows[0] ?? null;
  if (!first) out(`    OK: query succeeded but returned no rows for ${range.startDate}..${range.endDate} (no data yet).`);
  else out(`    OK: ${range.startDate}..${range.endDate}: views=${first.views}, minutesWatched=${first.estimatedMinutesWatched}`);
  return {
    channelId: ch.id,
    channelTitle: ch.snippet?.title ?? null,
    videoCount: ch.statistics?.videoCount ?? null,
    range,
    analytics: first ? { views: first.views, estimatedMinutesWatched: first.estimatedMinutesWatched } : null,
  };
}
