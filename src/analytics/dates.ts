import { InvalidInputError } from "../errors.js";

/**
 * Date handling for YouTube Analytics queries. All dates are calendar dates
 * (YYYY-MM-DD). YouTube Analytics reports use Pacific Time days; we compute
 * presets in UTC and end them DATA_LAG_DAYS before "today" because the most
 * recent days are usually not yet processed.
 */

export const DATA_LAG_DAYS = 2;

export const DATE_PRESETS = [
  "last_7_days",
  "last_28_days",
  "last_90_days",
  "last_365_days",
  "this_month",
  "last_month",
  "this_year",
  "last_year",
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const COMPARE_MODES = ["none", "previous_period", "previous_year", "custom"] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

export interface DateRange {
  startDate: string;
  endDate: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(s: string, field = "date"): Date {
  if (!DATE_RE.test(s)) throw new InvalidInputError(`${field} must be in YYYY-MM-DD format (got "${s}").`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || formatDate(d) !== s) throw new InvalidInputError(`${field} "${s}" is not a real calendar date.`);
  return d;
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

function firstOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function lastOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

/** Shift by whole months, clamping the day (e.g. Mar 31 - 1 month = Feb 28/29). */
export function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const target = new Date(Date.UTC(y, m, 1));
  const day = Math.min(d.getUTCDate(), daysInMonth(target.getUTCFullYear(), target.getUTCMonth()));
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day));
}

export function daysBetweenInclusive(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
}

export function isMonthAligned(r: DateRange): boolean {
  const s = parseDate(r.startDate);
  const e = parseDate(r.endDate);
  return s.getUTCDate() === 1 && formatDate(lastOfMonth(e)) === r.endDate;
}

export function resolvePreset(preset: DatePreset, today: Date): DateRange {
  const end = addDays(today, -DATA_LAG_DAYS);
  const rel = (n: number): DateRange => ({ startDate: formatDate(addDays(end, -(n - 1))), endDate: formatDate(end) });
  switch (preset) {
    case "last_7_days":
      return rel(7);
    case "last_28_days":
      return rel(28);
    case "last_90_days":
      return rel(90);
    case "last_365_days":
      return rel(365);
    case "this_month": {
      // If the month is too new to have processed data, the range is invalid (start > end)
      // and validation reports it instead of silently using last month.
      return { startDate: formatDate(firstOfMonth(today)), endDate: formatDate(end) };
    }
    case "last_month": {
      const prev = addMonths(firstOfMonth(today), -1);
      return { startDate: formatDate(prev), endDate: formatDate(lastOfMonth(prev)) };
    }
    case "this_year":
      return { startDate: `${today.getUTCFullYear()}-01-01`, endDate: formatDate(end) };
    case "last_year": {
      const y = today.getUTCFullYear() - 1;
      return { startDate: `${y}-01-01`, endDate: `${y}-12-31` };
    }
  }
}

export interface DateInput {
  preset?: DatePreset;
  start_date?: string;
  end_date?: string;
}

/** Resolve either a preset or explicit start/end dates into a validated range. */
export function resolveDateRange(input: DateInput, today: Date, fallback: DatePreset = "last_28_days"): DateRange {
  if (input.preset && (input.start_date || input.end_date)) {
    throw new InvalidInputError("Provide either `preset` or `start_date`/`end_date`, not both.");
  }
  let range: DateRange;
  if (input.start_date || input.end_date) {
    if (!input.start_date || !input.end_date) throw new InvalidInputError("Both `start_date` and `end_date` are required for a custom range.");
    range = { startDate: input.start_date, endDate: input.end_date };
  } else {
    range = resolvePreset(input.preset ?? fallback, today);
  }
  validateRange(range);
  return range;
}

export function validateRange(r: DateRange, label = "date range"): void {
  const s = parseDate(r.startDate, `${label} start`);
  const e = parseDate(r.endDate, `${label} end`);
  if (s > e) throw new InvalidInputError(`${label}: start date ${r.startDate} is after end date ${r.endDate}.`);
}

/**
 * Compute the comparison range.
 * - previous_period: the same number of days immediately before the range
 *   (whole calendar months if the range is month-aligned).
 * - previous_year: the same dates one year earlier.
 */
export function comparisonRange(range: DateRange, mode: Exclude<CompareMode, "none" | "custom">): DateRange {
  const s = parseDate(range.startDate);
  const e = parseDate(range.endDate);
  if (mode === "previous_year") {
    const ps = addMonths(s, -12);
    // Keep end-of-month semantics (e.g. 2024-02-29 -> 2023-02-28).
    const pe = formatDate(lastOfMonth(e)) === range.endDate ? lastOfMonth(addMonths(firstOfMonth(e), -12)) : addMonths(e, -12);
    return { startDate: formatDate(ps), endDate: formatDate(pe) };
  }
  if (isMonthAligned(range)) {
    const months = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth()) + 1;
    const ps = addMonths(s, -months);
    const pe = addDays(s, -1);
    return { startDate: formatDate(ps), endDate: formatDate(pe) };
  }
  const n = daysBetweenInclusive(s, e);
  const pe = addDays(s, -1);
  const ps = addDays(pe, -(n - 1));
  return { startDate: formatDate(ps), endDate: formatDate(pe) };
}
