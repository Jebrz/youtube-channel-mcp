import { SCOPES, YOUTUBE_ANALYTICS_BASE_URL } from "../config.js";
import { AuthRequiredError, InvalidInputError } from "../errors.js";
import type { GoogleClient } from "../google/client.js";
import { DATA_LAG_DAYS, comparisonRange, isMonthAligned, validateRange, type CompareMode, type DateRange } from "./dates.js";
import { MONETARY_METRICS, REPORTS, type ReportDef, type ReportScope } from "./reports.js";

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

interface AnalyticsApiResponse {
  kind?: string;
  columnHeaders?: Array<{ name: string; columnType: string; dataType: string }>;
  rows?: Array<Array<string | number>>;
}

export type Row = Record<string, string | number | null>;

export interface RawReport {
  columns: Array<{ name: string; type: string; dataType: string }>;
  rows: Row[];
}

export interface AnalyticsQuery {
  startDate: string;
  endDate: string;
  metrics: string[];
  dimensions: string[];
  filters?: string;
  sort?: string;
  maxResults?: number;
  startIndex?: number;
  currency?: string;
}

/** Thin wrapper around GET youtubeanalytics/v2/reports. */
export class YouTubeAnalyticsApi {
  constructor(private readonly client: GoogleClient) {}

  buildUrl(q: AnalyticsQuery): URL {
    const url = new URL(`${YOUTUBE_ANALYTICS_BASE_URL}/reports`);
    url.searchParams.set("ids", "channel==MINE");
    url.searchParams.set("startDate", q.startDate);
    url.searchParams.set("endDate", q.endDate);
    url.searchParams.set("metrics", q.metrics.join(","));
    if (q.dimensions.length) url.searchParams.set("dimensions", q.dimensions.join(","));
    if (q.filters) url.searchParams.set("filters", q.filters);
    if (q.sort) url.searchParams.set("sort", q.sort);
    if (q.maxResults !== undefined) url.searchParams.set("maxResults", String(q.maxResults));
    if (q.startIndex !== undefined) url.searchParams.set("startIndex", String(q.startIndex));
    if (q.currency) url.searchParams.set("currency", q.currency);
    return url;
  }

  async query(q: AnalyticsQuery): Promise<RawReport> {
    const res = await this.client.getJson<AnalyticsApiResponse>(this.buildUrl(q), "analytics");
    const headers = res.columnHeaders ?? [];
    const rows = (res.rows ?? []).map((r) => {
      const obj: Row = {};
      headers.forEach((h, i) => {
        const v = r[i];
        obj[h.name] = v === undefined ? null : v;
      });
      return obj;
    });
    return { columns: headers.map((h) => ({ name: h.name, type: h.columnType, dataType: h.dataType })), rows };
  }
}

export interface ReportRequest {
  scope: ReportScope;
  reportId: string;
  range: DateRange;
  compare: CompareMode;
  compareRange?: DateRange;
  metrics?: string[];
  videoId?: string;
  sort?: string;
  maxResults?: number;
  startIndex?: number;
  currency?: string;
}

export interface MetricChange {
  current: number | null;
  previous: number | null;
  absoluteChange: number | null;
  /** Percent change vs previous; null when previous is 0 or missing. */
  percentChange: number | null;
}

export interface ReportResult {
  report: string;
  description: string;
  dateRange: DateRange;
  dimensions: string[];
  metrics: string[];
  rows: Row[];
  rowCount: number;
  comparison?: {
    mode: CompareMode;
    dateRange: DateRange;
    rows: Row[];
    rowCount: number;
    /** Per-metric change for summary reports, or per-key changes for non-time dimensional reports. */
    changes?: Record<string, MetricChange> | Array<{ key: Record<string, string | number | null>; metrics: Record<string, MetricChange> }>;
  };
  notes: string[];
  query: Record<string, unknown>;
}

export function getReport(reportId: string, scope: ReportScope): ReportDef {
  const def = REPORTS[reportId];
  if (!def || !def.scopes.includes(scope)) {
    const valid = Object.values(REPORTS)
      .filter((r) => r.scopes.includes(scope))
      .map((r) => r.id);
    throw new InvalidInputError(`Unknown report "${reportId}" for ${scope} analytics. Valid reports: ${valid.join(", ")}.`);
  }
  return def;
}

export function resolveMetrics(def: ReportDef, requested: string[] | undefined): string[] {
  const metrics = requested && requested.length ? [...new Set(requested)] : [...def.defaultMetrics];
  const invalid = metrics.filter((m) => !def.allowedMetrics.includes(m));
  if (invalid.length) {
    throw new InvalidInputError(
      `Metric(s) ${invalid.join(", ")} are not supported by the "${def.id}" report.`,
      `Supported metrics for "${def.id}": ${def.allowedMetrics.join(", ")}.`,
    );
  }
  return metrics;
}

function toNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function metricChange(current: unknown, previous: unknown): MetricChange {
  const c = toNumber(current as string | number | null | undefined);
  const p = toNumber(previous as string | number | null | undefined);
  const abs = c !== null && p !== null ? round(c - p) : null;
  const pct = c !== null && p !== null && p !== 0 ? round(((c - p) / Math.abs(p)) * 100) : null;
  return { current: c, previous: p, absoluteChange: abs, percentChange: pct };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Run a validated report (with optional comparison period) against the Analytics API. */
export async function runReport(
  api: YouTubeAnalyticsApi,
  req: ReportRequest,
  ctx: { hasScope: (s: string) => boolean },
): Promise<ReportResult> {
  const def = getReport(req.reportId, req.scope);
  const metrics = resolveMetrics(def, req.metrics);
  const notes: string[] = [...(def.notes ?? [])];

  if (metrics.some((m) => MONETARY_METRICS.has(m)) && !ctx.hasScope(SCOPES.analyticsMonetaryReadonly)) {
    throw new AuthRequiredError(
      `Monetary metrics (${metrics.filter((m) => MONETARY_METRICS.has(m)).join(", ")}) need the yt-analytics-monetary.readonly scope, which was not granted.`,
      "Run `npx youtube-channel-mcp auth --monetary`. Revenue metrics only work for channels in the YouTube Partner Program.",
    );
  }

  let filters: string | undefined;
  if (req.scope === "video") {
    if (!req.videoId || !VIDEO_ID_RE.test(req.videoId)) {
      throw new InvalidInputError(`video_id must be an 11-character YouTube video ID (got "${req.videoId ?? ""}").`);
    }
    filters = `video==${req.videoId}`;
  }

  validateRange(req.range);
  let cmpRange: DateRange | undefined;
  if (req.compare === "custom") {
    if (!req.compareRange) throw new InvalidInputError("compare=custom requires compare_start_date and compare_end_date.");
    validateRange(req.compareRange, "comparison range");
    cmpRange = req.compareRange;
  } else if (req.compare !== "none") {
    cmpRange = comparisonRange(req.range, req.compare);
  }

  if (def.timeDimension === "month") {
    for (const [label, r] of [["date range", req.range], ["comparison range", cmpRange]] as const) {
      if (r && !isMonthAligned(r)) {
        throw new InvalidInputError(
          `The monthly report needs a ${label} that starts on the 1st and ends on the last day of a month (got ${r.startDate} to ${r.endDate}).`,
          "Use preset last_month / last_year, or the daily report for arbitrary ranges.",
        );
      }
    }
  }

  let sort: string | undefined;
  let maxResults: number | undefined;
  let startIndex: number | undefined;
  if (def.requiresSortAndMax) {
    const { allowedSorts, defaultSort, maxResultsLimit } = def.requiresSortAndMax;
    const s = (req.sort ?? defaultSort).replace(/^-/, "");
    if (!allowedSorts.includes(s)) {
      throw new InvalidInputError(`sort "${s}" is not supported for ${def.id}. Allowed: ${allowedSorts.join(", ")}.`);
    }
    if (MONETARY_METRICS.has(s) && !ctx.hasScope(SCOPES.analyticsMonetaryReadonly)) {
      throw new AuthRequiredError(`Sorting by ${s} needs the monetary scope.`, "Run `npx youtube-channel-mcp auth --monetary`.");
    }
    if (!metrics.includes(s)) metrics.push(s);
    sort = `-${s}`; // top videos: descending
    maxResults = req.maxResults ?? 25;
    if (maxResults < 1 || maxResults > maxResultsLimit) {
      throw new InvalidInputError(`max_results must be between 1 and ${maxResultsLimit} for ${def.id}.`);
    }
    startIndex = req.startIndex;
  }

  const base = {
    metrics,
    dimensions: def.dimensions,
    filters,
    sort,
    maxResults,
    startIndex,
    currency: req.currency,
  };
  const currentQ: AnalyticsQuery = { ...base, ...req.range };
  const [current, previous] = await Promise.all([
    api.query(currentQ),
    cmpRange ? api.query({ ...base, ...cmpRange }) : Promise.resolve(undefined),
  ]);

  const sortRows = (rows: Row[]) => sortForReport(def, rows, metrics);
  const rows = sortRows(current.rows);

  if (rows.length === 0) {
    notes.push(
      "YouTube Analytics returned no rows for this query. That means there is no recorded data for this range/filter (or it hasn't been processed yet) — no values were filled in.",
    );
  }
  notes.push(
    `Analytics data is typically delayed by 2-3 days; date presets end ${DATA_LAG_DAYS} days before today (UTC). YouTube Analytics days are in Pacific Time.`,
  );

  const result: ReportResult = {
    report: def.id,
    description: def.description,
    dateRange: req.range,
    dimensions: def.dimensions,
    metrics,
    rows,
    rowCount: rows.length,
    notes,
    query: {
      api: "youtubeAnalytics.reports.query (v2)",
      ids: "channel==MINE",
      ...req.range,
      metrics: metrics.join(","),
      dimensions: def.dimensions.join(",") || undefined,
      filters,
      sort,
      maxResults,
      startIndex,
      currency: req.currency,
    },
  };

  if (previous && cmpRange) {
    const prevRows = sortRows(previous.rows);
    const comparison: NonNullable<ReportResult["comparison"]> = {
      mode: req.compare,
      dateRange: cmpRange,
      rows: prevRows,
      rowCount: prevRows.length,
    };
    if (def.dimensions.length === 0) {
      const c = rows[0];
      const p = prevRows[0];
      comparison.changes = Object.fromEntries(metrics.map((m) => [m, metricChange(c?.[m], p?.[m])]));
      if (!c || !p) notes.push("One of the periods returned no data, so changes for it are null (not zero).");
    } else if (!def.timeDimension) {
      comparison.changes = joinByDimensions(def.dimensions, metrics, rows, prevRows);
      notes.push(
        "Comparison rows are joined on the report's dimensions. A null value means that key had no row in that period (it was absent, or outside the top results), not that the value was zero.",
      );
    } else {
      notes.push(
        "Time-series reports are returned as two separate series (rows and comparison.rows); use report=summary with the same ranges for period-over-period totals.",
      );
    }
    result.comparison = comparison;
  }

  return result;
}

function joinByDimensions(dims: string[], metrics: string[], cur: Row[], prev: Row[]) {
  const keyOf = (r: Row) => JSON.stringify(dims.map((d) => r[d] ?? null));
  const prevMap = new Map(prev.map((r) => [keyOf(r), r]));
  const curMap = new Map(cur.map((r) => [keyOf(r), r]));
  const keys = [...new Set([...curMap.keys(), ...prevMap.keys()])];
  return keys.map((k) => {
    const c = curMap.get(k);
    const p = prevMap.get(k);
    const src = (c ?? p)!;
    return {
      key: Object.fromEntries(dims.map((d) => [d, src[d] ?? null])),
      metrics: Object.fromEntries(metrics.map((m) => [m, metricChange(c?.[m], p?.[m])])),
    };
  });
}

function sortForReport(def: ReportDef, rows: Row[], metrics: string[]): Row[] {
  const copy = [...rows];
  if (def.timeDimension || def.id === "retention") {
    const dim = def.dimensions[0]!;
    return copy.sort((a, b) => {
      const x = a[dim];
      const y = b[dim];
      if (typeof x === "number" && typeof y === "number") return x - y;
      return String(x).localeCompare(String(y));
    });
  }
  if (def.requiresSortAndMax) return copy; // API already sorted.
  const m = metrics.includes("views") ? "views" : metrics[0]!;
  return copy.sort((a, b) => (toNumber(b[m]) ?? -Infinity) - (toNumber(a[m]) ?? -Infinity));
}
