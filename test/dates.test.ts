import { describe, expect, it } from "vitest";
import { comparisonRange, resolveDateRange, resolvePreset } from "../src/analytics/dates.js";
import { InvalidInputError } from "../src/errors.js";

const today = new Date("2026-11-03T12:00:00Z");

describe("date presets", () => {
  it("end 2 days before today to allow for data latency", () => {
    expect(resolvePreset("last_7_days", today)).toEqual({ startDate: "2026-10-26", endDate: "2026-11-01" });
    expect(resolvePreset("last_28_days", today)).toEqual({ startDate: "2026-10-05", endDate: "2026-11-01" });
  });
  it("calendar presets", () => {
    expect(resolvePreset("last_month", today)).toEqual({ startDate: "2026-10-01", endDate: "2026-10-31" });
    expect(resolvePreset("this_year", today)).toEqual({ startDate: "2026-01-01", endDate: "2026-11-01" });
    expect(resolvePreset("last_year", today)).toEqual({ startDate: "2025-01-01", endDate: "2025-12-31" });
    expect(resolvePreset("last_month", new Date("2026-01-15T00:00:00Z"))).toEqual({ startDate: "2025-12-01", endDate: "2025-12-31" });
  });
  it("this_month early in a month is rejected rather than inventing a range", () => {
    expect(() => resolveDateRange({ preset: "this_month" }, new Date("2026-11-01T00:00:00Z"))).toThrow(InvalidInputError);
  });
});

describe("custom ranges", () => {
  it("validates format, real dates, and ordering", () => {
    expect(resolveDateRange({ start_date: "2026-01-01", end_date: "2026-01-31" }, today)).toEqual({ startDate: "2026-01-01", endDate: "2026-01-31" });
    expect(() => resolveDateRange({ start_date: "2026-1-1", end_date: "2026-01-31" }, today)).toThrow(/YYYY-MM-DD/);
    expect(() => resolveDateRange({ start_date: "2026-02-30", end_date: "2026-03-01" }, today)).toThrow(/real calendar date/);
    expect(() => resolveDateRange({ start_date: "2026-03-01", end_date: "2026-02-01" }, today)).toThrow(/after/);
    expect(() => resolveDateRange({ start_date: "2026-03-01" }, today)).toThrow(/Both/);
    expect(() => resolveDateRange({ preset: "last_7_days", start_date: "2026-03-01", end_date: "2026-03-02" }, today)).toThrow(/either/);
  });
  it("defaults to last_28_days", () => {
    expect(resolveDateRange({}, today)).toEqual({ startDate: "2026-10-05", endDate: "2026-11-01" });
  });
});

describe("comparison periods", () => {
  it("previous_period: same number of days immediately before", () => {
    expect(comparisonRange({ startDate: "2026-10-05", endDate: "2026-11-01" }, "previous_period")).toEqual({
      startDate: "2026-09-07",
      endDate: "2026-10-04",
    });
  });
  it("previous_period for whole months shifts by calendar months", () => {
    expect(comparisonRange({ startDate: "2026-03-01", endDate: "2026-03-31" }, "previous_period")).toEqual({
      startDate: "2026-02-01",
      endDate: "2026-02-28",
    });
    expect(comparisonRange({ startDate: "2026-01-01", endDate: "2026-06-30" }, "previous_period")).toEqual({
      startDate: "2025-07-01",
      endDate: "2025-12-31",
    });
  });
  it("previous_year handles leap days", () => {
    expect(comparisonRange({ startDate: "2024-02-01", endDate: "2024-02-29" }, "previous_year")).toEqual({
      startDate: "2023-02-01",
      endDate: "2023-02-28",
    });
    expect(comparisonRange({ startDate: "2026-10-05", endDate: "2026-11-01" }, "previous_year")).toEqual({
      startDate: "2025-10-05",
      endDate: "2025-11-01",
    });
  });
});
