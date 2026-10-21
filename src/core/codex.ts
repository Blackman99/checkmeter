import { codexWeighted } from './weights.js';
import type { ParsedSource, Reading, SessionInfo, UsageEvent, WindowKind } from './types.js';
import { emptySource } from './types.js';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function windowKind(minutes: number | undefined, fallback: WindowKind): WindowKind {
  if (minutes == null) return fallback;
  if (minutes <= 6 * 60) return '5h';
  if (minutes >= 6 * 24 * 60 && minutes <= 8 * 24 * 60) return 'week';
  return 'other';
}

function normTier(t: unknown): string | undefined {
  if (typeof t !== 'string') return undefined;
  if (t === 'priority' || t === 'fast') return 'priority';
  if (t === 'flex') return 'flex';
  if (t === 'default' || t === 'standard') return 'standard';
  return undefined;
}

/**
 * Parse one Codex rollout file (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
 * Reads `session_meta`, `turn_context` (model), `thread_settings_applied` (service tier),
 * `token_count` events (tokens + the vendor's `rate_limits` meter reading) and compactions.
 */
export function parseCodexRollout(text: string, file: string): ParsedSource {
  const out = emptySource();
  const fileId = (file.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) || [])[1];
  const session: SessionInfo = { harness: 'codex', id: fileId || file, file, compactions: 0 };
  let model: string | undefined;
  let tier: string | undefined;
  let prevTotal = -1;
  let prevTotals: { input: number; cached: number; output: number; reasoning: number } | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || raw.charCodeAt(0) !== 123 /* { */) continue;
    let rec: any;
    try { rec = JSON.parse(raw); } catch { out.badLines++; continue; }
    const t = Date.parse(rec.timestamp);
    const p = rec.payload ?? {};
    const lineNo = i + 1;
    if (Number.isFinite(t)) {
      if (session.firstAt == null || t < session.firstAt) session.firstAt = t;
      if (session.lastAt == null || t > session.lastAt) session.lastAt = t;
    }
    switch (rec.type) {
      case 'session_meta': {
        if (typeof p.id === 'string' && !session.cwd) session.id = p.id;
        if (typeof p.cwd === 'string' && !session.cwd) session.cwd = p.cwd;
        if (typeof p.originator === 'string' && !session.originator) session.originator = p.originator;
        if (typeof p.cli_version === 'string' && !session.version) session.version = p.cli_version;
        const src = p.source;
        if (src && typeof src === 'object' && ('subagent' in src)) session.subagent = true;
        if (typeof src === 'string' && /subagent|review/i.test(src)) session.subagent = true;
        break;
      }
      case 'turn_context':
        if (typeof p.model === 'string') model = p.model;
        break;
      case 'compacted':
        session.compactions++;
        break;
      case 'event_msg': {
        if (p.type === 'thread_settings_applied') {
          const ts = p.thread_settings ?? {};
          if ('service_tier' in ts) tier = normTier(ts.service_tier);
          break;
        }
        if (p.type === 'context_compacted') { session.compactions++; break; }
        if (p.type !== 'token_count' || !Number.isFinite(t)) break;
        const info = p.info;
        if (info) {
          const total = info.total_token_usage;
          const last = info.last_token_usage;
          let d: { input: number; cached: number; output: number; reasoning: number } | null = null;
          const totalTokens = total ? num(total.total_tokens) || num(total.input_tokens) + num(total.output_tokens) : -1;
          if (total && totalTokens <= prevTotal) {
            d = null; // duplicate snapshot (Codex re-emits token_count with unchanged totals)
          } else if (last) {
            d = { input: num(last.input_tokens), cached: num(last.cached_input_tokens), output: num(last.output_tokens), reasoning: num(last.reasoning_output_tokens) };
          } else if (total) {
            const cur = { input: num(total.input_tokens), cached: num(total.cached_input_tokens), output: num(total.output_tokens), reasoning: num(total.reasoning_output_tokens) };
            d = prevTotals ? { input: cur.input - prevTotals.input, cached: cur.cached - prevTotals.cached, output: cur.output - prevTotals.output, reasoning: cur.reasoning - prevTotals.reasoning } : cur;
          }
          if (total) {
            prevTotal = Math.max(prevTotal, totalTokens);
            prevTotals = { input: num(total.input_tokens), cached: num(total.cached_input_tokens), output: num(total.output_tokens), reasoning: num(total.reasoning_output_tokens) };
          }
          if (d && (d.input > 0 || d.output > 0)) {
            const cached = Math.min(Math.max(d.cached, 0), d.input);
            const uncached = Math.max(d.input - cached, 0);
            const ev: UsageEvent = {
              harness: 'codex', t, session: session.id, file, line: lineNo, model: model ?? (typeof info.model === 'string' ? info.model : undefined), tier,
              input: uncached, cacheRead: cached, cacheWrite5m: 0, cacheWrite1h: 0, output: Math.max(d.output, 0), reasoning: Math.max(d.reasoning, 0),
              weighted: codexWeighted(uncached, cached, Math.max(d.output, 0)),
              contextTokens: d.input, contextWindow: num(info.model_context_window) || undefined, sidechain: session.subagent, version: session.version,
            };
            out.events.push(ev);
          }
        }
        const rl = p.rate_limits;
        if (rl && typeof rl === 'object') {
          for (const [key, fallback] of [['primary', '5h'], ['secondary', 'week']] as const) {
            const w = rl[key];
            if (!w || typeof w.used_percent !== 'number') continue;
            const r: Reading = {
              harness: 'codex', t, window: windowKind(typeof w.window_minutes === 'number' ? w.window_minutes : undefined, fallback),
              windowMinutes: typeof w.window_minutes === 'number' ? w.window_minutes : undefined,
              usedPercent: w.used_percent,
              resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : undefined,
              plan: typeof rl.plan_type === 'string' ? rl.plan_type : undefined,
              limitId: typeof rl.limit_id === 'string' ? rl.limit_id : undefined,
              reached: typeof rl.rate_limit_reached_type === 'string' ? rl.rate_limit_reached_type : undefined,
              session: session.id, file, line: lineNo,
            };
            out.readings.push(r);
          }
        }
        break;
      }
    }
  }
  // events parsed before session_meta's id was known carry the file id; fix them up
  for (const e of out.events) e.session = session.id;
  for (const r of out.readings) r.session = session.id;
  for (const e of out.events) e.sidechain = session.subagent;
  if (out.events.length || out.readings.length || session.cwd) out.sessions.push(session);
  return out;
}
