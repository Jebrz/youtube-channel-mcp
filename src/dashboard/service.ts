import { comparisonRange, resolveDateRange, type DatePreset } from "../analytics/dates.js";
import { errorToToolPayload } from "../errors.js";
import { getChannelAnalytics, getChannelOverview, type ToolDeps } from "../tools.js";

/**
 * Server-side dashboard aggregation with caching.
 *
 * Why server-side caching: an artifact may be open in several tabs, polled
 * hourly, and refreshed by hand. All of that funnels into one cached entry per
 * (preset, compare), so YouTube API quota is spent at most once per TTL.
 *
 * Failure policy (per section, never fabricated):
 * - success           -> status "ok", data replaces the last-good copy
 * - failure + last-good exists -> status "stale", last-good data kept, error attached
 * - failure + nothing cached   -> status "error", data null
 */

export const DASHBOARD_PRESETS = ["last_7_days", "last_28_days", "last_90_days"] as const;
export type DashboardPreset = (typeof DASHBOARD_PRESETS)[number];
export const DASHBOARD_COMPARES = ["previous_period", "previous_year"] as const;
export type DashboardCompare = (typeof DASHBOARD_COMPARES)[number];

export const SECTION_IDS = ["overview", "summary", "daily", "topVideos", "trafficSources"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export interface SectionError {
  code: string;
  message: string;
  hint?: string;
}

export interface Section {
  status: "ok" | "stale" | "error";
  /** Last successful payload for this section (null if it never succeeded). */
  data: unknown;
  /** When `data` was fetched from Google (ISO). */
  fetchedAt: string | null;
  /** Present when the most recent attempt for this section failed. */
  error?: SectionError;
}

export interface DashboardPayload {
  schemaVersion: 1;
  request: { preset: DashboardPreset; compare: DashboardCompare };
  reportingPeriod: { current: { startDate: string; endDate: string }; comparison: { startDate: string; endDate: string } };
  /** Server time when this response was produced (ISO). */
  generatedAt: string;
  /** When the most recent attempt to reach Google started (ISO). */
  lastAttemptAt: string;
  /** Most recent time every section was fetched successfully in one attempt, or null. */
  lastFullSuccessAt: string | null;
  /** True when any section is showing old data or no data because of an error. */
  stale: boolean;
  cache: {
    /** True if this response was served from the server cache without calling Google. */
    hit: boolean;
    ageSeconds: number;
    ttlSeconds: number;
    /** Earliest time a forced refresh will actually call Google again (ISO). */
    nextForcedRefreshAt: string;
    throttled?: boolean;
  };
  sections: Record<SectionId, Section>;
  notes: string[];
}

export interface DashboardOptions {
  /** Serve cached data without calling Google for this long. Default 15 min. */
  ttlMs?: number;
  /** A forced refresh within this window of the last attempt is served from cache. Default 60 s. */
  minForceIntervalMs?: number;
  /** After an attempt where every section failed, wait this long before trying again. Default 60 s. */
  failureBackoffMs?: number;
  /** Rows to request for top videos. Default 10. */
  topVideos?: number;
  now?: () => number;
}

interface Entry {
  sections: Record<SectionId, Section>;
  lastAttemptAt: number;
  lastFullSuccessAt: number | null;
  allFailed: boolean;
  periods: DashboardPayload["reportingPeriod"];
}

type Fetchers = Record<SectionId, () => Promise<unknown>>;

export class DashboardService {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Entry>>();
  private readonly ttlMs: number;
  private readonly minForceIntervalMs: number;
  private readonly failureBackoffMs: number;
  private readonly topVideos: number;
  private readonly now: () => number;
  /** Number of times Google was actually contacted (for tests/diagnostics). */
  upstreamAttempts = 0;

  constructor(
    private readonly deps: ToolDeps,
    opts: DashboardOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
    this.minForceIntervalMs = opts.minForceIntervalMs ?? 60_000;
    this.failureBackoffMs = opts.failureBackoffMs ?? 60_000;
    this.topVideos = opts.topVideos ?? 10;
    this.now = opts.now ?? Date.now;
  }

  async get(input: { preset?: DashboardPreset; compare?: DashboardCompare; force_refresh?: boolean } = {}): Promise<DashboardPayload> {
    const preset = input.preset ?? "last_28_days";
    const compare = input.compare ?? "previous_period";
    const key = `${preset}|${compare}`;
    const existing = this.entries.get(key);
    const now = this.now();

    let hit = false;
    let throttled = false;
    let entry: Entry;

    if (existing && !this.shouldFetch(existing, now, Boolean(input.force_refresh))) {
      hit = true;
      throttled = Boolean(input.force_refresh);
      entry = existing;
    } else {
      entry = await this.fetchCoalesced(key, preset, compare, existing);
    }
    return this.toPayload(entry, preset, compare, hit, throttled);
  }

  private shouldFetch(e: Entry, now: number, force: boolean): boolean {
    const age = now - e.lastAttemptAt;
    if (e.allFailed) return age >= this.failureBackoffMs;
    if (force) return age >= this.minForceIntervalMs;
    return age >= this.ttlMs;
  }

  private fetchCoalesced(key: string, preset: DashboardPreset, compare: DashboardCompare, previous: Entry | undefined): Promise<Entry> {
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.fetchEntry(preset, compare, previous)
      .then((e) => {
        this.entries.set(key, e);
        return e;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private fetchers(preset: DashboardPreset, compare: DashboardCompare): Fetchers {
    const d = this.deps;
    return {
      overview: () => getChannelOverview(d),
      summary: () => getChannelAnalytics(d, { report: "summary", preset, compare }),
      daily: () =>
        getChannelAnalytics(d, { report: "daily", preset, compare, metrics: ["views", "estimatedMinutesWatched", "subscribersGained", "subscribersLost"] }),
      topVideos: () =>
        getChannelAnalytics(d, {
          report: "top_videos",
          preset,
          max_results: this.topVideos,
          metrics: ["views", "estimatedMinutesWatched", "averageViewDuration", "likes", "subscribersGained"],
        }),
      trafficSources: () => getChannelAnalytics(d, { report: "traffic_source", preset, compare }),
    };
  }

  private async fetchEntry(preset: DashboardPreset, compare: DashboardCompare, previous: Entry | undefined): Promise<Entry> {
    this.upstreamAttempts++;
    const attemptAt = this.now();
    const current = resolveDateRange({ preset }, this.deps.today());
    const periods = { current, comparison: comparisonRange(current, compare) };
    const fetchers = this.fetchers(preset, compare);
    const results = await Promise.allSettled(SECTION_IDS.map((id) => fetchers[id]()));

    const sections = {} as Record<SectionId, Section>;
    let okCount = 0;
    SECTION_IDS.forEach((id, i) => {
      const r = results[i]!;
      const prev = previous?.sections[id];
      const hasGood = prev && prev.fetchedAt !== null;
      if (r.status === "fulfilled") {
        okCount++;
        sections[id] = { status: "ok", data: r.value, fetchedAt: new Date(attemptAt).toISOString() };
      } else {
        const error = errorToToolPayload(r.reason).error;
        sections[id] = hasGood
          ? { status: "stale", data: prev.data, fetchedAt: prev.fetchedAt, error }
          : { status: "error", data: null, fetchedAt: null, error };
      }
    });

    return {
      sections,
      lastAttemptAt: attemptAt,
      lastFullSuccessAt: okCount === SECTION_IDS.length ? attemptAt : previous?.lastFullSuccessAt ?? null,
      allFailed: okCount === 0,
      periods,
    };
  }

  private toPayload(e: Entry, preset: DashboardPreset, compare: DashboardCompare, hit: boolean, throttled: boolean): DashboardPayload {
    const now = this.now();
    const notes = [
      "Values come only from the YouTube Data API and YouTube Analytics API. Missing values are null, never zero.",
      "Analytics data usually lags 2-3 days; periods end 2 days before today (UTC) and YouTube days are Pacific Time.",
      `Server cache: up to ${Math.round(this.ttlMs / 60000)} minutes; forced refreshes at most every ${Math.round(this.minForceIntervalMs / 1000)} seconds.`,
    ];
    if (throttled) notes.push("Refresh requested too soon after the previous one; served the cached result to protect API quota.");
    const stale = Object.values(e.sections).some((s) => s.status !== "ok");
    return {
      schemaVersion: 1,
      request: { preset, compare },
      reportingPeriod: e.periods,
      generatedAt: new Date(now).toISOString(),
      lastAttemptAt: new Date(e.lastAttemptAt).toISOString(),
      lastFullSuccessAt: e.lastFullSuccessAt === null ? null : new Date(e.lastFullSuccessAt).toISOString(),
      stale,
      cache: {
        hit,
        ageSeconds: Math.round((now - e.lastAttemptAt) / 1000),
        ttlSeconds: Math.round(this.ttlMs / 1000),
        nextForcedRefreshAt: new Date(e.lastAttemptAt + (e.allFailed ? this.failureBackoffMs : this.minForceIntervalMs)).toISOString(),
        ...(throttled ? { throttled: true } : {}),
      },
      sections: e.sections,
      notes,
    };
  }
}
