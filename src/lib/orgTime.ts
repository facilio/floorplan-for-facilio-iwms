/**
 * Org-timezone time math. Booking epochs must be computed in the ORG's timezone, not the
 * browser's: a user in a different zone booking "10:00" means 10:00 at the facility — using
 * the browser zone shifted every timestamp by the zone gap. `tz` is an IANA name (e.g.
 * "Asia/Riyadh") from the org's account properties; null falls back to the browser zone
 * (correct whenever the org has no explicit timezone, or in local/prototype mode).
 */

/** What the clock in `tz` shows at instant `at`, expressed as a UTC-ms offset from `at`. */
function tzOffsetMs(tz: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // hour comes back as "24" at midnight in some engines — normalize.
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUTC - at;
}

/** True when `tz` is a usable IANA zone on this engine. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Epoch ms of `dateISO` + `minutes` as WALL-CLOCK TIME in `tz` (null = browser zone). */
export function epochAtInTz(dateISO: string, minutes: number, tz: string | null): number {
  const [y, m, d] = dateISO.split('-').map(Number);
  if (!tz) {
    return new Date(y, (m || 1) - 1, d || 1, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime();
  }
  // Guess the instant as if the wall time were UTC, then correct by the zone's offset at that
  // instant; one refinement pass handles DST boundaries where the first guess lands on the
  // other side of the transition.
  const utcGuess = Date.UTC(y, (m || 1) - 1, d || 1, Math.floor(minutes / 60), minutes % 60, 0, 0);
  let t = utcGuess - tzOffsetMs(tz, utcGuess);
  const off2 = tzOffsetMs(tz, t);
  if (utcGuess - off2 !== t) t = utcGuess - off2;
  return t;
}

/** The wall-clock date + minutes that `epoch` shows in `tz` (null = browser zone). */
export function wallClockInTz(epoch: number, tz: string | null): { dateISO: string; minutes: number } {
  if (!tz) {
    const d = new Date(epoch);
    return {
      dateISO: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      minutes: d.getHours() * 60 + d.getMinutes(),
    };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(epoch));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    dateISO: `${get('year')}-${String(get('month')).padStart(2, '0')}-${String(get('day')).padStart(2, '0')}`,
    minutes: (get('hour') % 24) * 60 + get('minute'),
  };
}

// ---------------------------------------------------------------------------
// Resolved-zone registry + org clock. fetchOrgTimezone (facilioApiDataSource) resolves the
// org's zone once and registers it here; synchronous UI code then derives "now"/"today" from
// the ORG clock — the browser zone only ever serves as the unresolved/local-mode fallback.
// ---------------------------------------------------------------------------
let resolvedTz: string | null = null;
export function setOrgTimezone(tz: string | null): void {
  resolvedTz = tz;
}
export function orgTimezone(): string | null {
  return resolvedTz;
}
/** The org's wall clock RIGHT NOW: today's ISO date + minutes since midnight. */
export function orgNow(): { dateISO: string; minutes: number } {
  return wallClockInTz(Date.now(), resolvedTz);
}
