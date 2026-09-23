// Date-range filtering for the merchant Negotiations page. Kept free of
// imports so it can be tested on its own.
//
// Every "day" here means a day in the merchant's OWN store timezone (Shop's
// ianaTimezone from the Admin API, e.g. "America/Chicago"), not UTC and not
// the server's own timezone. A merchant clicking "Today" needs to actually
// see today in their own store's time, not wherever this app's server
// happens to run.
//
// The 30-day cap here is a product decision (mirrors the 30-day window the
// data-retention job uses elsewhere), not a technical limit: negotiation
// records themselves are kept far longer, this just limits how far back a
// merchant can filter on this page.

// Inclusive: "last 30 days" means today plus the 29 days before it.
const MAX_DAYS_BACK = 29;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Used only if a store's own timezone value is ever missing or not a real
// IANA name (shouldn't happen - it comes straight from Shopify - but a
// filter silently computing wrong boundaries is worse than one that's
// visibly UTC).
const FALLBACK_TIMEZONE = "Etc/UTC";

// Confirms a timezone name is one Node's own Intl implementation actually
// recognizes, before ever using it. Intl.DateTimeFormat throws a RangeError
// for a bogus zone, this turns that into a plain false instead of crashing
// the whole page.
export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimezone(ianaTimezone: string | null | undefined): string {
  if (ianaTimezone && isValidTimezone(ianaTimezone)) return ianaTimezone;
  return FALLBACK_TIMEZONE;
}

// "What calendar date is it right now, in this timezone" as YYYY-MM-DD.
// en-CA is the trick: that locale's short date format IS YYYY-MM-DD, so this
// needs no manual assembly of the parts.
function dateKeyNowIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function addDaysUTC(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return dateKeyNowIn("Etc/UTC", new Date(Date.UTC(y, m - 1, d + days)));
}

// A day is only a real, in-range day if it round-trips through Date.UTC
// unchanged. Catches out-of-range values regex alone would let through, like
// 2026-02-31 or 2026-13-01, which JS "normalizes" into a different date
// instead of rejecting.
function isRealDateKey(dateKey: string): boolean {
  if (!DATE_RE.test(dateKey)) return false;
  const [y, m, d] = dateKey.split("-").map(Number);
  const roundTrip = new Date(Date.UTC(y, m - 1, d));
  return (
    roundTrip.getUTCFullYear() === y &&
    roundTrip.getUTCMonth() === m - 1 &&
    roundTrip.getUTCDate() === d
  );
}

// The UTC offset actually in effect for this timezone at this instant, in
// minutes, positive means the zone is ahead of UTC (e.g. +330 for
// Asia/Kolkata). Needs Node's full ICU data, which every supported Node
// version here (20.19+ / 22.12+, see package.json engines) ships by default.
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(instant);
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  if (raw === "GMT") return 0;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(raw);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

// The UTC instant for a specific wall-clock moment (a calendar date plus
// hour/minute/second/ms) as it would read on a clock in timeZone.
//
// The offset is read at midday UTC on that same calendar date, not at the
// target moment itself, deliberately: reading it exactly at midnight would
// be ambiguous or wrong on the handful of days a year a zone's clocks
// actually change. Using midday sidesteps that. The one real, known edge
// case this doesn't cover: a store in a zone whose daylight-saving change
// happens to land in the middle of the day (rare, and even then the boundary
// is off by at most an hour, not a full day).
function localMomentToUTC(
  dateKey: string,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string,
): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  const probeAtMidday = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const offsetMinutes = offsetMinutesAt(probeAtMidday, timeZone);
  return new Date(
    Date.UTC(y, m - 1, d, hour, minute, second, ms) - offsetMinutes * 60000,
  );
}

export type AllowedWindow = { minDate: string; maxDate: string };

// The full span a merchant is allowed to filter within, in their own store's
// timezone. maxDate is always "today" there; a merchant can't filter into
// their own future.
export function getAllowedWindow(
  timeZone: string,
  now: Date = new Date(),
): AllowedWindow {
  const maxDate = dateKeyNowIn(timeZone, now);
  return { minDate: addDaysUTC(maxDate, -MAX_DAYS_BACK), maxDate };
}

export type DateFilter = { from: string; to: string };

// Turns whatever came in on the URL (?from=&to=, both optional, either or
// both possibly missing, malformed, swapped, or outside the allowed window)
// into a valid filter, or null if there's no real filter to apply (both
// params missing, or both malformed). Out-of-window or swapped dates are
// clamped rather than rejected outright, so an old bookmarked or hand-edited
// link still shows something sensible instead of an error.
export function parseDateFilter(
  fromRaw: unknown,
  toRaw: unknown,
  timeZone: string,
  now: Date = new Date(),
): DateFilter | null {
  const { minDate, maxDate } = getAllowedWindow(timeZone, now);
  const from = typeof fromRaw === "string" && isRealDateKey(fromRaw)
    ? fromRaw
    : null;
  const to = typeof toRaw === "string" && isRealDateKey(toRaw) ? toRaw : null;
  if (from === null && to === null) return null;

  const clamp = (key: string) =>
    key < minDate ? minDate : key > maxDate ? maxDate : key;
  let start = clamp(from ?? to!);
  let end = clamp(to ?? from!);
  if (start > end) [start, end] = [end, start];
  return { from: start, to: end };
}

// The inclusive day boundaries for a filter, as real Date instances (for a
// Prisma createdAt: { gte, lte } clause), computed in the store's own
// timezone: "from" starts at local midnight, "to" ends at the last
// millisecond of that local day.
export function dateFilterToBounds(
  filter: DateFilter,
  timeZone: string,
): { gte: Date; lte: Date } {
  return {
    gte: localMomentToUTC(filter.from, 0, 0, 0, 0, timeZone),
    lte: localMomentToUTC(filter.to, 23, 59, 59, 999, timeZone),
  };
}

export type DatePreset = "today" | "yesterday" | "last7" | "last30";

// Shopify-style quick presets, anchored to "today" in the store's own
// timezone. Each already respects the 30-day cap by construction (last30 IS
// the cap), so none of these ever need clamping.
export function getPresetRange(
  preset: DatePreset,
  timeZone: string,
  now: Date = new Date(),
): DateFilter {
  const today = dateKeyNowIn(timeZone, now);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const yesterday = addDaysUTC(today, -1);
      return { from: yesterday, to: yesterday };
    }
    case "last7":
      return { from: addDaysUTC(today, -6), to: today };
    case "last30":
      return { from: addDaysUTC(today, -MAX_DAYS_BACK), to: today };
  }
}

// True if this filter matches one of the presets exactly, so the UI can
// highlight the matching button rather than always showing a bare date range.
export function matchingPreset(
  filter: DateFilter | null,
  timeZone: string,
  now: Date = new Date(),
): DatePreset | null {
  if (!filter) return null;
  const presets: DatePreset[] = ["today", "yesterday", "last7", "last30"];
  for (const preset of presets) {
    const p = getPresetRange(preset, timeZone, now);
    if (p.from === filter.from && p.to === filter.to) return preset;
  }
  return null;
}
