import type { Harness, Reading, WindowKind } from './types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Where the open window is heading at the rate you are going now.
 *
 * 5-hour window: the rate over the last hour of readings (or since the window opened,
 * if that's sooner), so it is "this session's" pace, idle minutes included.
 * Weekly window: points per calendar day since the window opened, because nobody codes
 * around the clock and a one-hour rate would be a wild over-estimate for a week.
 */
export interface Pace {
  harness: Harness;
  window: '5h' | 'week';
  limitId?: string;
  /** early: the window has under 10 minutes (5h) or 6 hours (week) of readings, too soon to call */
  state: 'runs-out' | 'on-pace' | 'idle' | 'at-limit' | 'early';
  /** the reading the forecast starts from */
  at: Reading;
  used: number;
  resetsAt?: number;
  /** meter points per hour (5h) or per day (week) */
  rate?: number;
  rateUnit: 'h' | 'day';
  /** the rate is measured from this time */
  rateFrom?: number;
  /** when the meter reaches 100% at this rate (state runs-out) */
  outAt?: number;
  /** minutes between outAt and the reset (state runs-out) */
  earlyMin?: number;
  /** meter at the reset if the pace holds (state on-pace) */
  atReset?: number;
}

export interface PaceOptions {
  /** a 5h forecast needs a reading at most this old (default 30 min), else the window is idle */
  freshMin?: number;
}

/** Readings of one series (same harness, limit, window), any order. Returns undefined when the window is closed or there is nothing to say. */
export function paceFor(readings: Reading[], now: number, opts: PaceOptions = {}): Pace | undefined {
  const rs = readings.filter((r) => r.t <= now && (r.window === '5h' || r.window === 'week')).sort((a, b) => a.t - b.t);
  if (!rs.length) return undefined;
  const last = rs[rs.length - 1];
  const window = last.window as '5h' | 'week';
  const base = { harness: last.harness, window, limitId: last.limitId, at: last, used: last.usedPercent, resetsAt: last.resetsAt, rateUnit: window === '5h' ? 'h' as const : 'day' as const };
  if (last.resetsAt == null || last.resetsAt <= now) return undefined; // the window has rolled over since; a fresh one has no pace yet
  if (last.usedPercent >= 100) return { ...base, state: 'at-limit' };
  const tol = window === '5h' ? 10 * MIN : HOUR;
  // the current window: walk back while the reset time stays put (a credit inside the window doesn't end it)
  let i = rs.length - 1;
  while (i > 0) {
    const p = rs[i - 1];
    if (p.resetsAt == null || Math.abs(p.resetsAt - last.resetsAt) > tol) break;
    i--;
  }
  const win = rs.slice(i);
  const unitMs = window === '5h' ? HOUR : DAY;
  if (window === '5h') {
    const fresh = (opts.freshMin ?? 30) * MIN;
    if (now - last.t > fresh) return { ...base, state: 'idle' };
    const from = win.find((r) => r.t >= last.t - HOUR) ?? win[0];
    // a window opened by this stretch counts from 0% at its start
    const opened = last.resetsAt - 5 * HOUR;
    const startT = win[0] === from && from.t - opened < 15 * MIN && opened < from.t ? opened : from.t;
    const startU = startT === opened ? 0 : from.usedPercent;
    const span = last.t - startT;
    const rose = last.usedPercent - startU;
    if (span < 10 * MIN) return { ...base, state: 'early', rateFrom: startT };
    return project(base, Math.max(0, rose) / (span / unitMs), startT, unitMs);
  }
  // week: since the window opened (resetsAt − 7 days), calendar time
  const opened = last.resetsAt - 7 * DAY;
  // readings start when the files do; if the first one is right at the opening, count from 0%
  const startT = win[0].t - opened < 15 * MIN ? opened : win[0].t;
  const startU = startT === opened ? 0 : win[0].usedPercent;
  const span = last.t - startT;
  if (span < 6 * HOUR) return { ...base, state: 'early', rateFrom: startT };
  return project(base, Math.max(0, last.usedPercent - startU) / (span / unitMs), startT, unitMs);
}

function project(base: Omit<Pace, 'state'>, rate: number, rateFrom: number, unitMs: number): Pace {
  const left = 100 - base.used;
  const outAt = rate > 0 ? base.at.t + (left / rate) * unitMs : Infinity;
  if (outAt < base.resetsAt!) return { ...base, state: 'runs-out', rate, rateFrom, outAt, earlyMin: (base.resetsAt! - outAt) / MIN };
  return { ...base, state: 'on-pace', rate, rateFrom, atReset: Math.min(100, base.used + rate * ((base.resetsAt! - base.at.t) / unitMs)) };
}

/** One forecast per open series (5h and week, every harness / limit). */
export function paces(readings: Reading[], now: number, opts: PaceOptions = {}): Pace[] {
  const groups = new Map<string, Reading[]>();
  for (const r of readings) {
    if (r.window !== '5h' && r.window !== 'week') continue;
    const k = `${r.harness}|${r.limitId ?? ''}|${r.window as WindowKind}`;
    let g = groups.get(k); if (!g) { g = []; groups.set(k, g); } g.push(r);
  }
  const out: Pace[] = [];
  for (const g of groups.values()) { const p = paceFor(g, now, opts); if (p) out.push(p); }
  const ord = (p: Pace) => (p.harness === 'codex' ? 0 : 1) * 2 + (p.window === '5h' ? 0 : 1);
  return out.sort((a, b) => ord(a) - ord(b));
}

export function fmtDur(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h >= 48) return `${Math.round(m / 1440)} days`;
  return r ? `${h} h ${r} min` : `${h} h`;
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
/** "11:24" on the same day as `now`, "Thu 29 Oct 10:00" otherwise */
export function fmtNear(t: number, now: number): string {
  const d = new Date(t), n = new Date(now);
  if (d.toDateString() === n.toDateString()) return hm(d);
  return `${WD[d.getDay()]}\u00a0${d.getDate()}\u00a0${MO[d.getMonth()]}\u00a0${hm(d)}`; // no-break spaces: a date never wraps mid-way
}
const pct = (p: number) => `${Math.abs(p - Math.round(p)) < 0.05 ? Math.round(p) : p.toFixed(1)}%`;

/** Plain-text pieces of one forecast, shared by the CLI report, the web analyser and the status line. */
export function paceLine(p: Pace, now: number): { now: string; rate: string; verdict: string } {
  const at = pct(p.used);
  const reset = p.resetsAt != null ? fmtNear(p.resetsAt, now) : 'unknown';
  const from = p.rateFrom == null ? '' : p.window === 'week' ? ` since ${fmtNear(p.rateFrom, now).replace(/\u00a0\d\d:\d\d$/, '')}` : ` since ${fmtNear(p.rateFrom, now)}`;
  const rate = p.rate != null ? `${p.rate >= 10 ? p.rate.toFixed(0) : p.rate.toFixed(1)} pts/${p.rateUnit}${from}` : '';
  switch (p.state) {
    case 'at-limit': return { now: at, rate: '', verdict: `at the limit until the reset at ${reset}` };
    case 'idle': return { now: at, rate: '', verdict: `idle since ${fmtNear(p.at.t, now)}; the window resets at ${reset}` };
    case 'early': return { now: at, rate: '', verdict: `too early in the window to call; resets at ${reset}` };
    case 'runs-out': return { now: at, rate, verdict: `runs out ≈ ${fmtNear(p.outAt!, now)}, ${fmtDur(p.earlyMin!)} before the reset at ${reset}` };
    default: return { now: at, rate, verdict: `on pace for ${Math.round(p.atReset ?? p.used)}% at the reset (${reset})` };
  }
}

/** The status-line form: "out 11:24" when this pace empties the window before it resets. */
export function paceShort(p: Pace | undefined, now: number): string | undefined {
  if (!p || p.state !== 'runs-out') return undefined;
  return `out ${fmtNear(p.outAt!, now)}`;
}
