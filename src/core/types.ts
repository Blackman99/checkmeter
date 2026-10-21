export type Harness = 'codex' | 'claude';

/** One model request as logged by the harness, with tokens already split by price class. */
export interface UsageEvent {
  harness: Harness;
  /** epoch ms */
  t: number;
  session: string;
  file: string;
  line: number;
  model?: string;
  /** codex service tier (standard | priority | flex) or claude speed (standard | fast) */
  tier?: string;
  /** uncached input tokens */
  input: number;
  /** cache reads (codex: cached_input_tokens) */
  cacheRead: number;
  /** claude cache writes, 5-minute TTL */
  cacheWrite5m: number;
  /** claude cache writes, 1-hour TTL */
  cacheWrite1h: number;
  output: number;
  reasoning: number;
  /** price-weighted tokens (see weights.ts) */
  weighted: number;
  /** context the request carried, when known */
  contextTokens?: number;
  contextWindow?: number;
  sidechain?: boolean;
  version?: string;
}

export type WindowKind = '5h' | 'week' | 'other';

/** One reading of the vendor's own usage meter. */
export interface Reading {
  harness: Harness;
  /** epoch ms */
  t: number;
  window: WindowKind;
  windowMinutes?: number;
  usedPercent: number;
  /** epoch ms */
  resetsAt?: number;
  plan?: string;
  limitId?: string;
  reached?: string;
  session?: string;
  file: string;
  line: number;
}

export interface SessionInfo {
  harness: Harness;
  id: string;
  file: string;
  cwd?: string;
  originator?: string;
  version?: string;
  subagent?: boolean;
  compactions: number;
  firstAt?: number;
  lastAt?: number;
}

export interface ParsedSource {
  events: UsageEvent[];
  readings: Reading[];
  sessions: SessionInfo[];
  /** lines that were not valid JSON (the harness may be mid-write) */
  badLines: number;
}

export function emptySource(): ParsedSource {
  return { events: [], readings: [], sessions: [], badLines: 0 };
}

export function mergeSources(list: ParsedSource[]): ParsedSource {
  const out = emptySource();
  for (const s of list) {
    out.events.push(...s.events);
    out.readings.push(...s.readings);
    out.sessions.push(...s.sessions);
    out.badLines += s.badLines;
  }
  return out;
}
