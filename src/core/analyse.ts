import type { Harness, ParsedSource, Reading, SessionInfo, UsageEvent, WindowKind } from './types.js';

export const MTOK = 1_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type FindingKind = 'OFF_LEDGER' | 'FAST_METER' | 'STUCK_RESET' | 'PLAN_CHANGED' | 'METER_DROP' | 'LIMIT_HIT' | 'CACHE_TTL' | 'NO_METER' | 'NO_BASELINE';
export type Severity = 'flag' | 'review' | 'note';

export interface Finding {
  kind: FindingKind;
  harness: Harness;
  window?: WindowKind;
  severity: Severity;
  /** one line, plain text, no colour */
  title: string;
  /** explanation lines */
  detail: string[];
  /** the meter readings this finding rests on (first / last at least) */
  readings: Reading[];
  from?: number;
  to?: number;
  /** meter points involved */
  delta?: number;
  /** meter points your local tokens explain at your baseline rate */
  expected?: number;
  /** weighted tokens logged locally in the span */
  tokens?: number;
  rate?: number;
  baseline?: number;
  ratio?: number;
}

export interface Interval {
  series: string;
  harness: Harness;
  window: WindowKind;
  from: Reading;
  to: Reading;
  delta: number;
  reset: boolean;
  stuck: boolean;
  tokens: number;
  bySession: Map<string, number>;
  gapMin: number;
}

export interface SeriesSummary {
  key: string;
  harness: Harness;
  window: WindowKind;
  limitId?: string;
  plans: string[];
  readings: number;
  first?: Reading;
  last?: Reading;
  /** meter points per million weighted tokens, median of your own days */
  baseline?: number;
  baselineDays: number;
  totalDelta: number;
  attributed: number;
  unexplained: number;
  resets: number;
}

export interface SessionRow {
  harness: Harness;
  id: string;
  file: string;
  cwd?: string;
  firstAt?: number;
  lastAt?: number;
  model?: string;
  tier?: string;
  weighted: number;
  tokens: number;
  requests: number;
  d5h: number;
  dWeek: number;
  subagent: boolean;
  /** false when the session ran before the first meter reading we have */
  metered?: boolean;
  causes: string[];
}

export interface HarnessSummary {
  harness: Harness;
  files: number;
  sessions: number;
  events: number;
  readings: number;
  weighted: number;
  plans: string[];
}

export interface Report {
  tool: 'checkmeter';
  version: string;
  generatedAt: number;
  since: number;
  now: number;
  harnesses: HarnessSummary[];
  series: SeriesSummary[];
  findings: Finding[];
  sessions: SessionRow[];
  intervals?: Interval[];
}

export interface AnalyseOptions {
  now: number;
  since: number;
  version?: string;
  /** how many times your baseline rate counts as a fast meter (default 2) */
  fastRatio?: number;
  /** files scanned per harness, for the header */
  files?: Partial<Record<Harness, number>>;
  keepIntervals?: boolean;
}

const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function topShare(m: Map<string, number>): [string | undefined, number] {
  let best: string | undefined; let bv = 0; let tot = 0;
  for (const [k, v] of m) { tot += v; if (v > bv) { bv = v; best = k; } }
  return [best, tot ? bv / tot : 0];
}

function addTo(m: Map<string, number>, k: string | undefined, v: number) { if (!k) return; m.set(k, (m.get(k) ?? 0) + v); }

/** Keep the first copy of every event / reading (subagent rollouts replay their parent's history). */
export function dedupe(src: ParsedSource): ParsedSource {
  const seenE = new Set<string>();
  const events: UsageEvent[] = [];
  for (const e of src.events) {
    const k = `${e.harness}|${e.t}|${e.input}|${e.cacheRead}|${e.cacheWrite5m}|${e.cacheWrite1h}|${e.output}`;
    if (seenE.has(k)) continue; seenE.add(k); events.push(e);
  }
  const seenR = new Set<string>();
  const readings: Reading[] = [];
  for (const r of src.readings) {
    const k = `${r.harness}|${r.limitId ?? ''}|${r.window}|${r.t}|${r.usedPercent}`;
    if (seenR.has(k)) continue; seenR.add(k); readings.push(r);
  }
  return { ...src, events, readings };
}

export function analyse(input: ParsedSource, opts: AnalyseOptions): Report {
  const src = dedupe(input);
  const { now, since } = opts;
  const fastRatio = opts.fastRatio ?? 2;
  const events = src.events.filter((e) => e.t >= since && e.t <= now).sort((a, b) => a.t - b.t);
  const allReadings = src.readings.filter((r) => r.t <= now).sort((a, b) => a.t - b.t);
  const findings: Finding[] = [];
  const series: SeriesSummary[] = [];
  const intervalsOut: Interval[] = [];
  // per-session attribution of meter points
  const attr = new Map<string, { d5h: number; dWeek: number }>();
  const sessAttr = (h: Harness, id: string) => { const k = `${h}|${id}`; let v = attr.get(k); if (!v) { v = { d5h: 0, dWeek: 0 }; attr.set(k, v); } return v; };

  const byHarnessEvents: Record<Harness, UsageEvent[]> = { codex: [], claude: [] };
  for (const e of events) byHarnessEvents[e.harness].push(e);

  // ---- group readings into series
  const groups = new Map<string, Reading[]>();
  for (const r of allReadings) {
    if (r.window === 'other') continue;
    const key = `${r.harness}|${r.limitId ?? ''}|${r.window}`;
    let g = groups.get(key); if (!g) { g = []; groups.set(key, g); } g.push(r);
  }

  for (const [key, all] of groups) {
    const harness = all[0].harness;
    const window = all[0].window;
    // one anchor reading before `since`, then everything in range
    let startIdx = all.findIndex((r) => r.t >= since);
    if (startIdx < 0) continue;
    if (startIdx > 0) startIdx--;
    const rs = all.slice(startIdx);
    const evs = byHarnessEvents[harness];
    const tol = window === '5h' ? 10 * MIN : 60 * MIN;
    const intervals: Interval[] = [];
    let ei = 0;
    while (ei < evs.length && evs[ei].t <= rs[0].t) ei++;
    for (let i = 1; i < rs.length; i++) {
      const a = rs[i - 1]; const b = rs[i];
      let same = true;
      if (a.resetsAt != null && b.resetsAt != null) same = Math.abs(a.resetsAt - b.resetsAt) <= tol || b.resetsAt < a.resetsAt;
      else if (b.usedPercent < a.usedPercent - 20 && a.resetsAt != null && b.t >= a.resetsAt - tol) same = false;
      const reset = !same;
      const windowStart = reset && a.resetsAt != null ? Math.max(a.t, Math.min(a.resetsAt, b.t)) : a.t;
      const bySession = new Map<string, number>();
      let tokens = 0;
      while (ei < evs.length && evs[ei].t <= b.t) {
        const e = evs[ei++];
        if (e.t <= windowStart) continue;
        tokens += e.weighted; addTo(bySession, e.session, e.weighted);
      }
      const delta = reset ? b.usedPercent : b.usedPercent - a.usedPercent;
      const stuck = !reset && a.resetsAt != null && b.t > a.resetsAt + 3 * MIN && b.usedPercent >= a.usedPercent - 0.5 && b.usedPercent > 0;
      intervals.push({ series: key, harness, window, from: a, to: b, delta, reset, stuck, tokens, bySession, gapMin: (b.t - a.t) / MIN });
    }

    // ---- baseline: your own meter points per weighted Mtok, per day of steady work
    const perDay = new Map<string, { delta: number; tokens: number; models: Map<string, number>; tiers: Map<string, number>; first: Interval; last: Interval }>();
    for (const iv of intervals) {
      if (iv.reset || iv.stuck || iv.delta < 0 || iv.tokens <= 0 || iv.gapMin > 30) continue;
      const k = dayKey(iv.to.t);
      let d = perDay.get(k);
      if (!d) { d = { delta: 0, tokens: 0, models: new Map(), tiers: new Map(), first: iv, last: iv }; perDay.set(k, d); }
      d.delta += iv.delta; d.tokens += iv.tokens; d.last = iv;
    }
    // model / tier mix per day, from the events themselves
    for (const e of evs) {
      const d = perDay.get(dayKey(e.t)); if (!d) continue;
      addTo(d.models, e.model ?? 'unknown', e.weighted); addTo(d.tiers, e.tier ?? 'standard', e.weighted);
    }
    const rates: { day: string; rate: number; d: typeof perDay extends Map<string, infer V> ? V : never }[] = [];
    for (const [day, d] of perDay) {
      if (d.tokens < 0.2 * MTOK || d.delta < 1) continue;
      rates.push({ day, rate: d.delta / (d.tokens / MTOK), d });
    }
    rates.sort((x, y) => (x.day < y.day ? -1 : 1));
    const baseline = rates.length >= 3 ? median(rates.map((r) => r.rate)) : undefined;
    const dayRates = new Map(rates.map((r) => [r.day, r.rate] as const));
    const fallbackRate = (() => {
      let dl = 0, tk = 0;
      for (const iv of intervals) if (!iv.reset && !iv.stuck && iv.delta >= 0 && iv.tokens > 0 && iv.gapMin <= 30) { dl += iv.delta; tk += iv.tokens; }
      return tk > 0 && dl > 0 ? dl / (tk / MTOK) : undefined;
    })();
    const rateForExpect = baseline ?? fallbackRate;

    // ---- FAST METER (day level, merged across consecutive days)
    if (baseline != null) {
      const baseModels = new Map<string, number>(); const baseTiers = new Map<string, number>();
      for (const r of rates) if (r.rate < fastRatio * baseline) { for (const [k, v] of r.d.models) addTo(baseModels, k, v); for (const [k, v] of r.d.tiers) addTo(baseTiers, k, v); }
      const [bModel, bModelShare] = topShare(baseModels);
      const basePrio = (baseTiers.get('priority') ?? 0) + (baseTiers.get('fast') ?? 0);
      const baseTierShare = basePrio / ([...baseTiers.values()].reduce((a, b) => a + b, 0) || 1);
      let run: typeof rates = [];
      const flush = () => {
        if (!run.length) return;
        const delta = run.reduce((a, r) => a + r.d.delta, 0);
        const tokens = run.reduce((a, r) => a + r.d.tokens, 0);
        const rate = delta / (tokens / MTOK);
        if (delta >= 3) {
          const models = new Map<string, number>(); const tiers = new Map<string, number>();
          for (const r of run) { for (const [k, v] of r.d.models) addTo(models, k, v); for (const [k, v] of r.d.tiers) addTo(tiers, k, v); }
          const [m, mShare] = topShare(models);
          const prio = ((tiers.get('priority') ?? 0) + (tiers.get('fast') ?? 0)) / ([...tiers.values()].reduce((a, b) => a + b, 0) || 1);
          const sameModel = m === bModel;
          const sameTier = Math.abs(prio - baseTierShare) < 0.2;
          const ratio = rate / baseline;
          const detail: string[] = [];
          detail.push(`${fmtPts(delta)} of the ${window === '5h' ? '5-hour' : 'weekly'} meter for ${fmtTok(tokens)} weighted tokens = ${rate.toFixed(2)} pts/M, ${ratio.toFixed(1)}× your baseline ${baseline.toFixed(2)} pts/M (median of ${rates.length} days)`);
          detail.push(`model mix: ${m ?? 'unknown'} ${(mShare * 100).toFixed(0)}% (baseline days: ${bModel ?? 'unknown'} ${(bModelShare * 100).toFixed(0)}%) · priority/fast tier ${(prio * 100).toFixed(0)}% (baseline ${(baseTierShare * 100).toFixed(0)}%)`);
          if (sameModel && sameTier) detail.push('same model and speed tier as your normal days, so the meter moved faster for the same kind of work');
          else detail.push('the model or speed tier differs from your normal days, which can explain part of it');
          findings.push({
            kind: 'FAST_METER', harness, window, severity: sameModel && sameTier ? 'flag' : 'review',
            title: `${window === '5h' ? '5h' : 'week'} meter ran ${ratio.toFixed(1)}× your baseline on ${fmtDaySpan(run[0].d.first.to.t, run[run.length - 1].d.last.to.t)}`,
            detail, readings: [run[0].d.first.from, run[run.length - 1].d.last.to], from: run[0].d.first.from.t, to: run[run.length - 1].d.last.to.t,
            delta, tokens, rate, baseline, ratio,
          });
        }
        run = [];
      };
      for (const r of rates) { if (r.rate >= fastRatio * baseline) run.push(r); else flush(); }
      flush();
    } else if (intervals.length && window === 'week') {
      findings.push({ kind: 'NO_BASELINE', harness, window, severity: 'note', title: `not enough history for a ${harness} baseline yet (${rates.length} day${rates.length === 1 ? '' : 's'} of steady work, need 3)`, detail: ['FAST METER needs at least three days with readings and real work; OFF-LEDGER uses your overall rate until then.'], readings: [] });
    }

    // ---- OFF-LEDGER, STUCK RESET, METER DROP (interval level)
    let attributed = 0; let unexplained = 0; let totalDelta = 0; let resets = 0;
    let off: Interval[] = [];
    const flushOff = () => {
      if (!off.length) return;
      const delta = off.reduce((a, x) => a + x.delta, 0);
      const tokens = off.reduce((a, x) => a + x.tokens, 0);
      const expected = rateForExpect != null ? tokens / MTOK * rateForExpect : 0;
      const a = off[0].from; const b = off[off.length - 1].to;
      findings.push({
        kind: 'OFF_LEDGER', harness, window, severity: 'flag',
        title: `${window === '5h' ? '5h' : 'week'} meter rose ${fmtPts(delta)} that no session on this machine explains`,
        detail: [
          `between ${fmtWhen(a.t)} (${fmtPct(a.usedPercent)}) and ${fmtWhen(b.t)} (${fmtPct(b.usedPercent)}) local sessions logged ${fmtTok(tokens)} weighted tokens, ≈ ${fmtPts(expected)} at your ${baseline != null ? 'baseline' : 'average'} rate`,
          harness === 'codex'
            ? 'usage that reached the meter from somewhere this machine did not log: cloud tasks, another computer, the desktop app on another profile, or ChatGPT Work sharing the pool'
            : 'usage that reached the meter from somewhere this machine did not log: claude.ai chat, Claude on another computer, or cloud sessions',
        ],
        readings: [a, b], from: a.t, to: b.t, delta, expected, tokens,
      });
      off = [];
    };
    let stuckRun: Interval[] = [];
    const flushStuck = () => {
      if (!stuckRun.length) return;
      const a = stuckRun[0].from; const b = stuckRun[stuckRun.length - 1].to;
      findings.push({
        kind: 'STUCK_RESET', harness, window, severity: 'flag',
        title: `${window === '5h' ? '5h' : 'week'} window was due to reset at ${fmtWhen(a.resetsAt!)} and didn't`,
        detail: [`reading at ${fmtWhen(b.t)} still shows ${fmtPct(b.usedPercent)} with the same reset time (${fmtWhen(b.resetsAt ?? a.resetsAt!)})`, `${stuckRun.length} reading${stuckRun.length === 1 ? '' : 's'} after the reset time stayed in the old window`],
        readings: [a, b], from: a.t, to: b.t, delta: b.usedPercent - a.usedPercent,
      });
      stuckRun = [];
    };
    for (const iv of intervals) {
      if (iv.reset) resets++;
      if (iv.stuck) { stuckRun.push(iv); } else flushStuck();
      if (iv.delta < -1 && !iv.reset) {
        findings.push({
          kind: 'METER_DROP', harness, window, severity: 'review',
          title: `${window === '5h' ? '5h' : 'week'} meter went down ${fmtPts(-iv.delta)} without a reset`,
          detail: [`${fmtWhen(iv.from.t)} ${fmtPct(iv.from.usedPercent)} → ${fmtWhen(iv.to.t)} ${fmtPct(iv.to.usedPercent)}, same window (resets ${iv.to.resetsAt ? fmtWhen(iv.to.resetsAt) : 'unknown'})`, 'a correction or a credit on the vendor side; worth matching against any email you got'],
          readings: [iv.from, iv.to], from: iv.from.t, to: iv.to.t, delta: iv.delta,
        });
      }
      if (iv.delta <= 0) { flushOff(); continue; }
      totalDelta += iv.delta;
      const expected = rateForExpect != null ? iv.tokens / MTOK * rateForExpect : (iv.tokens > 0 ? iv.delta : 0);
      // judge against the faster of your baseline and that day's own rate, so a fast-meter day
      // (its own finding) doesn't also light up every single request as off-ledger
      const dayRate = dayRates.get(dayKey(iv.to.t));
      const hiRate = Math.max(rateForExpect ?? 0, dayRate ?? 0);
      const expectedHi = rateForExpect != null || dayRate != null ? iv.tokens / MTOK * hiRate : expected;
      const isOff = iv.delta >= 3 && iv.delta - expectedHi >= 2.5 && expectedHi < iv.delta / 2 && !iv.stuck;
      const share = isOff ? Math.max(0, Math.min(iv.delta, expected)) : iv.delta;
      if (isOff) { off.push(iv); unexplained += iv.delta - share; } else flushOff();
      if (iv.tokens > 0) {
        for (const [sid, w] of iv.bySession) {
          const pts = share * (w / iv.tokens);
          const a = sessAttr(harness, sid);
          if (window === '5h') a.d5h += pts; else a.dWeek += pts;
        }
        attributed += share;
      } else if (!isOff) unexplained += iv.delta;
    }
    flushOff(); flushStuck();

    const plans = [...new Set(rs.map((r) => r.plan).filter((p): p is string => !!p))];
    series.push({ key, harness, window, limitId: rs[0].limitId, plans, readings: rs.filter((r) => r.t >= since).length, first: rs[0], last: rs[rs.length - 1], baseline, baselineDays: rates.length, totalDelta, attributed, unexplained, resets });
    if (opts.keepIntervals) intervalsOut.push(...intervals);
  }

  // ---- PLAN CHANGED / LIMIT HIT (per harness, from any window)
  for (const h of ['codex', 'claude'] as Harness[]) {
    const rs = allReadings.filter((r) => r.harness === h && r.t >= since && r.window !== 'other');
    let prev: Reading | undefined;
    for (const r of rs) {
      if (!r.plan) continue;
      if (prev && prev.plan && r.plan !== prev.plan) {
        findings.push({ kind: 'PLAN_CHANGED', harness: h, severity: 'review', title: `meter readings switched plan: ${prev.plan} → ${r.plan}`,
          detail: [`last "${prev.plan}" reading ${fmtWhen(prev.t)}, first "${r.plan}" reading ${fmtWhen(r.t)}`, 'if you did not change plans, the meter was applying a different plan\'s limits in this span'],
          readings: [prev, r], from: prev.t, to: r.t });
      }
      prev = r;
    }
    const hitDays = new Set<string>();
    for (const r of rs) {
      if (!r.reached) continue;
      const k = dayKey(r.t) + r.reached; if (hitDays.has(k)) continue; hitDays.add(k);
      findings.push({ kind: 'LIMIT_HIT', harness: h, window: r.window, severity: 'note', title: `limit reached (${r.reached.replace(/_/g, ' ')}) at ${fmtWhen(r.t)}`, detail: [`${r.window} meter at ${fmtPct(r.usedPercent)}`], readings: [r], from: r.t, to: r.t });
    }
  }

  // ---- sessions + causes
  const sessionInfo = new Map<string, SessionInfo>();
  for (const s of src.sessions) { const k = `${s.harness}|${s.id}`; const prev = sessionInfo.get(k); if (!prev) sessionInfo.set(k, s); else { prev.compactions = Math.max(prev.compactions, s.compactions); prev.subagent = prev.subagent || s.subagent; } }
  const rows = new Map<string, SessionRow & { _models: Map<string, number>; _tiers: Map<string, number>; _ev: UsageEvent[] }>();
  for (const e of events) {
    const k = `${e.harness}|${e.session}`;
    let r = rows.get(k);
    if (!r) {
      const info = sessionInfo.get(k);
      r = { harness: e.harness, id: e.session, file: info?.file ?? e.file, cwd: info?.cwd, firstAt: e.t, lastAt: e.t, weighted: 0, tokens: 0, requests: 0, d5h: 0, dWeek: 0, subagent: !!(info?.subagent || e.sidechain), causes: [], _models: new Map(), _tiers: new Map(), _ev: [] };
      rows.set(k, r);
    }
    r.lastAt = e.t; r.weighted += e.weighted; r.tokens += e.input + e.cacheRead + e.cacheWrite5m + e.cacheWrite1h + e.output; r.requests++;
    addTo(r._models, e.model ?? 'unknown', e.weighted); addTo(r._tiers, e.tier ?? 'standard', e.weighted); r._ev.push(e);
  }
  const fastSpans = findings.filter((f) => f.kind === 'FAST_METER' && f.severity === 'flag');
  const firstReading: Partial<Record<Harness, number>> = {};
  for (const r of allReadings) if (r.window !== 'other' && firstReading[r.harness] == null) firstReading[r.harness] = r.t;
  const sessions: SessionRow[] = [];
  for (const [k, r] of rows) {
    const a = attr.get(k);
    if (a) { r.d5h = a.d5h; r.dWeek = a.dWeek; }
    r.model = topShare(r._models)[0];
    const prio = ((r._tiers.get('priority') ?? 0) + (r._tiers.get('fast') ?? 0)) / (r.weighted || 1);
    r.tier = prio >= 0.5 ? (r.harness === 'claude' ? 'fast' : 'priority') : 'standard';
    r.causes = sessionCauses(r._ev, r, sessionInfo.get(k), prio);
    const fast = fastSpans.find((f) => f.harness === r.harness && f.from != null && f.to != null && r.firstAt! <= f.to && r.lastAt! >= f.from);
    if (fast) r.causes.unshift(`meter ran ${fast.ratio!.toFixed(1)}× fast that day`);
    const fr = firstReading[r.harness];
    r.metered = fr != null && r.lastAt! >= fr;
    const { _models, _tiers, _ev, ...clean } = r; void _models; void _tiers; void _ev;
    sessions.push(clean);
  }
  sessions.sort((x, y) => (y.dWeek + y.d5h / 10) - (x.dWeek + x.d5h / 10) || y.weighted - x.weighted);

  // ---- Claude-only findings
  const claudeEv = byHarnessEvents.claude;
  if (claudeEv.length) {
    const ttl = cacheTtlFinding(claudeEv);
    if (ttl) findings.push(ttl);
    const hasMeter = allReadings.some((r) => r.harness === 'claude');
    if (!hasMeter) findings.push({ kind: 'NO_METER', harness: 'claude', severity: 'note', title: 'Claude Code keeps no meter readings on disk, so its meter cannot be checked yet', detail: ['run `checkmeter setup claude` once: the status line then records each 5h / weekly reading to ~/.checkmeter/claude-meter.jsonl', 'local causes below are still exact (they come from your transcripts)'], readings: [] });
  }

  mergeWindows(findings);
  const order: Record<Severity, number> = { flag: 0, review: 1, note: 2 };
  findings.sort((x, y) => order[x.severity] - order[y.severity] || (x.from ?? 0) - (y.from ?? 0));

  const harnesses: HarnessSummary[] = (['codex', 'claude'] as Harness[]).map((h) => ({
    harness: h, files: opts.files?.[h] ?? 0,
    sessions: sessions.filter((s) => s.harness === h).length,
    events: byHarnessEvents[h].length,
    readings: allReadings.filter((r) => r.harness === h && r.t >= since).length,
    weighted: byHarnessEvents[h].reduce((a, e) => a + e.weighted, 0),
    plans: [...new Set(allReadings.filter((r) => r.harness === h && r.plan).map((r) => r.plan!))],
  }));

  return { tool: 'checkmeter', version: opts.version ?? '0.0.0', generatedAt: now, since, now, harnesses, series, findings, sessions, ...(opts.keepIntervals ? { intervals: intervalsOut } : {}) };
}

function sessionCauses(ev: UsageEvent[], r: SessionRow, info: SessionInfo | undefined, prio: number): string[] {
  const out: { text: string; score: number }[] = [];
  const W = r.weighted || 1;
  if (r.subagent) out.push({ text: r.harness === 'codex' ? 'subagent session' : 'subagent / sidechain', score: 0.5 });
  if (prio >= 0.2) out.push({ text: `${r.harness === 'claude' ? 'fast mode' : 'priority tier'} ${(prio * 100).toFixed(0)}%`, score: prio + 0.2 });
  if (r.harness === 'codex') {
    let input = 0, cached = 0, near = 0, out_ = 0, reas = 0;
    for (const e of ev) {
      input += e.input + e.cacheRead; cached += e.cacheRead; out_ += e.output; reas += e.reasoning;
      if (e.contextWindow && e.contextTokens && e.contextTokens >= 0.85 * e.contextWindow) near++;
    }
    const unc = input ? 1 - cached / input : 0;
    if (near >= 3) out.push({ text: `near context limit ×${near}`, score: 0.3 + near / Math.max(ev.length, 1) });
    if (input >= 200_000 && unc >= 0.4) out.push({ text: `uncached input ${(unc * 100).toFixed(0)}%`, score: unc });
    if (out_ > 0 && reas / out_ >= 0.7 && out_ >= 50_000) out.push({ text: `reasoning ${(reas / out_ * 100).toFixed(0)}% of output`, score: 0.25 });
  } else {
    // rebuilds after idle: a big cache write after a gap longer than the cache TTL
    let rebuilds = 0, rebuildW = 0, w5 = 0, w1 = 0, ctx = 0;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]; w5 += e.cacheWrite5m; w1 += e.cacheWrite1h; ctx = Math.max(ctx, e.contextTokens ?? 0);
      if (i === 0) continue;
      const gap = e.t - ev[i - 1].t;
      const writes = e.cacheWrite5m + e.cacheWrite1h;
      const ttl = e.cacheWrite1h > e.cacheWrite5m ? HOUR : 5 * MIN;
      if (writes >= 20_000 && gap > ttl) { rebuilds++; rebuildW += e.cacheWrite5m * 1.25 + e.cacheWrite1h * 2; }
    }
    if (rebuilds) out.push({ text: `cache rebuilt after idle ×${rebuilds} (${(rebuildW / W * 100).toFixed(0)}%)`, score: rebuildW / W + 0.1 });
    if (w5 + w1 >= 100_000 && w1 === 0) out.push({ text: '5-minute cache only', score: 0.15 });
    if (ctx >= 150_000) out.push({ text: `context up to ${fmtTok(ctx)}`, score: 0.12 });
  }
  if ((info?.compactions ?? 0) >= 1) out.push({ text: `compacted ×${info!.compactions}`, score: 0.1 + 0.05 * info!.compactions });
  out.sort((a, b) => b.score - a.score);
  return out.map((o) => o.text);
}

function cacheTtlFinding(ev: UsageEvent[]): Finding | undefined {
  const byVer = new Map<string, { w5: number; w1: number; first: number; last: number }>();
  for (const e of ev) {
    if (!e.version) continue;
    let v = byVer.get(e.version); if (!v) { v = { w5: 0, w1: 0, first: e.t, last: e.t }; byVer.set(e.version, v); }
    v.w5 += e.cacheWrite5m; v.w1 += e.cacheWrite1h; v.last = Math.max(v.last, e.t); v.first = Math.min(v.first, e.t);
  }
  const vers = [...byVer.entries()].sort((a, b) => cmpVer(a[0], b[0]));
  let lastWith1h = -1;
  vers.forEach(([, v], i) => { if (v.w1 > 0) lastWith1h = i; });
  if (lastWith1h < 0 || lastWith1h === vers.length - 1) return undefined;
  const after = vers.slice(lastWith1h + 1).filter(([, v]) => v.w5 > 0);
  const w5After = after.reduce((a, [, v]) => a + v.w5, 0);
  if (!after.length || w5After < 50_000) return undefined;
  const before = vers[lastWith1h];
  return {
    kind: 'CACHE_TTL', harness: 'claude', severity: 'flag',
    title: `1-hour prompt cache stopped after Claude Code ${before[0]}`,
    detail: [
      `${before[0]} wrote ${fmtTok(before[1].w1)} tokens to the 1-hour cache; ${after.map(([k]) => k).join(', ')} wrote ${fmtTok(w5After)} tokens and all of them to the 5-minute cache`,
      'a 5-minute cache goes cold during any pause over 5 minutes, and the next request pays to write the whole context again (see anthropics/claude-code#103673)',
    ],
    readings: [], from: before[1].last, to: after[after.length - 1][1].last,
  };
}

/** FAST METER / OFF-LEDGER often hit the 5h and weekly meter over the same span: show them as one finding. */
function mergeWindows(fs: Finding[]) {
  for (const kind of ['FAST_METER', 'OFF_LEDGER'] as FindingKind[]) {
    const list = fs.filter((f) => f.kind === kind);
    for (const a of list) {
      if (a.window !== '5h') continue;
      const b = list.find((x) => x !== a && x.window === 'week' && x.harness === a.harness && x.severity === a.severity && x.from != null && a.from != null && Math.abs(x.from - a.from) < 2 * HOUR && Math.abs((x.to ?? 0) - (a.to ?? 0)) < 2 * HOUR);
      if (!b) continue;
      if (kind === 'FAST_METER') {
        a.title = `meter ran ${a.ratio!.toFixed(1)}× your baseline on ${fmtDaySpan(a.from!, a.to!)} (5h ${a.ratio!.toFixed(1)}×, week ${b.ratio!.toFixed(1)}×)`;
        a.detail = [a.detail[0], b.detail[0], ...a.detail.slice(1)];
      } else {
        a.title = `meter rose ${fmtPts(a.delta!)} (5h) and ${fmtPts(b.delta!)} (week) that no session on this machine explains`;
        a.detail = [a.detail[0].replace(/\((\d[^)]*%)\)/g, '($1 of 5h)'), ...a.detail.slice(1)];
      }
      (a as any).also = b;
      a.readings = [...a.readings, ...b.readings.filter((r) => !a.readings.includes(r))];
      fs.splice(fs.indexOf(b), 1);
      list.splice(list.indexOf(b), 1);
    }
  }
}

export function fmtDaySpan(a: number, b: number): string {
  const da = new Date(a), db = new Date(b);
  const one = (d: Date, withMonth: boolean) => `${WD[d.getDay()]} ${d.getDate()}${withMonth ? ' ' + MO[d.getMonth()] : ''}`;
  if (dayKey(a) === dayKey(b)) return one(da, true);
  return `${one(da, da.getMonth() !== db.getMonth())} – ${one(db, true)}`;
}

function cmpVer(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0); const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}

// ---- small formatters shared with the renderers
export function fmtPts(p: number): string { const a = Math.abs(p); return `${a >= 10 ? a.toFixed(0) : a.toFixed(1)} pts`; }
export function fmtPct(p: number): string { return `${Math.abs(p - Math.round(p)) < 0.05 ? Math.round(p) : p.toFixed(1)}%`; }
export function fmtTok(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return `${Math.round(n)}`;
}
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtWhen(t: number): string {
  const d = new Date(t);
  return `${WD[d.getDay()]} ${d.getDate()} ${MO[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export { DAY, HOUR, MIN };
