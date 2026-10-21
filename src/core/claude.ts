import { claudeWeighted } from './weights.js';
import type { ParsedSource, Reading, SessionInfo, UsageEvent } from './types.js';
import { emptySource } from './types.js';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Parse one Claude Code transcript (`~/.claude/projects/<project>/<session>.jsonl`,
 * subagents under `<session>/subagents/*.jsonl`). Claude Code streams one assistant
 * message over several lines; usage is de-duplicated by message id + request id,
 * keeping the last (most complete) copy.
 */
export function parseClaudeTranscript(text: string, file: string): ParsedSource {
  const out = emptySource();
  const isSubFile = /[\\/]subagents[\\/]/.test(file);
  const fileId = (file.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) || [])[1];
  const base = (file.split(/[\\/]/).pop() || file).replace(/\.jsonl$/, '');
  const session: SessionInfo = { harness: 'claude', id: isSubFile ? `${fileId ?? 'session'}:${base}` : (fileId || file), file, compactions: 0, subagent: isSubFile };
  const byKey = new Map<string, UsageEvent>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || raw.charCodeAt(0) !== 123) continue;
    let rec: any;
    try { rec = JSON.parse(raw); } catch { out.badLines++; continue; }
    if (typeof rec.sessionId === 'string' && !isSubFile) session.id = rec.sessionId;
    if (typeof rec.cwd === 'string' && !session.cwd) session.cwd = rec.cwd;
    if (typeof rec.version === 'string') session.version = rec.version;
    if (rec.type === 'system' && rec.subtype === 'compact_boundary') session.compactions++;
    if (rec.isCompactSummary) session.compactions++;
    const msg = rec.message;
    const u = msg?.usage;
    if (!u || rec.type !== 'assistant') continue;
    const t = Date.parse(rec.timestamp);
    if (!Number.isFinite(t)) continue;
    if (session.firstAt == null || t < session.firstAt) session.firstAt = t;
    if (session.lastAt == null || t > session.lastAt) session.lastAt = t;
    const cc = u.cache_creation ?? {};
    let w5 = num(cc.ephemeral_5m_input_tokens);
    let w1h = num(cc.ephemeral_1h_input_tokens);
    const wTotal = num(u.cache_creation_input_tokens);
    if (w5 + w1h === 0 && wTotal > 0) w5 = wTotal; // older transcripts: no TTL split, the API default is 5 m
    const input = num(u.input_tokens);
    const read = num(u.cache_read_input_tokens);
    const output = num(u.output_tokens);
    const speed = typeof u.speed === 'string' ? (u.speed === 'fast' ? 'fast' : 'standard') : undefined;
    const ev: UsageEvent = {
      harness: 'claude', t, session: session.id, file, line: i + 1,
      model: typeof msg.model === 'string' ? msg.model : undefined, tier: speed,
      input, cacheRead: read, cacheWrite5m: w5, cacheWrite1h: w1h, output, reasoning: 0,
      weighted: claudeWeighted(input, read, w5, w1h, output),
      contextTokens: input + read + w5 + w1h,
      sidechain: isSubFile || rec.isSidechain === true, version: typeof rec.version === 'string' ? rec.version : undefined,
    };
    const key = `${msg.id ?? ''}|${rec.requestId ?? ''}` || `${i}`;
    if (msg.model === '<synthetic>') continue;
    byKey.set(key === '|' ? `line${i}` : key, ev);
  }
  for (const e of byKey.values()) { e.session = session.id; out.events.push(e); }
  if (out.events.length) out.sessions.push(session);
  return out;
}

/** A status-line snapshot as written by `checkmeter record`. */
export interface MeterSnapshot {
  t: number; // epoch ms
  session?: string;
  model?: string;
  version?: string;
  fast?: boolean;
  ttl?: string;
  five_hour?: { used_percentage: number; resets_at?: number };
  seven_day?: { used_percentage: number; resets_at?: number };
  spend_limit?: { used_percentage: number; resets_at?: number; used_usd?: number; limit_usd?: number };
}

/** Read the recorder log (`~/.checkmeter/claude-meter.jsonl`) into meter readings. */
export function parseClaudeMeterLog(text: string, file: string): ParsedSource {
  const out = emptySource();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || raw.charCodeAt(0) !== 123) continue;
    let s: MeterSnapshot;
    try { s = JSON.parse(raw); } catch { out.badLines++; continue; }
    if (typeof s.t !== 'number') continue;
    const add = (w: { used_percentage: number; resets_at?: number } | undefined, window: '5h' | 'week', minutes: number, limitId?: string) => {
      if (!w || typeof w.used_percentage !== 'number') return;
      const r: Reading = { harness: 'claude', t: s.t, window, windowMinutes: minutes, usedPercent: w.used_percentage,
        resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : undefined, session: s.session, file, line: i + 1, limitId };
      out.readings.push(r);
    };
    add(s.five_hour, '5h', 300);
    add(s.seven_day, 'week', 10080);
    if (s.spend_limit) add(s.spend_limit, 'week', 0, 'spend_limit');
  }
  // spend limit is its own series; keep its window as 'other' so it never mixes with the plan meter
  for (const r of out.readings) if (r.limitId === 'spend_limit') { r.window = 'other'; r.windowMinutes = undefined; }
  return out;
}
