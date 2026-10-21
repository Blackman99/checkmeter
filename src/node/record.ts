import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MeterSnapshot } from '../core/claude.js';

/**
 * Claude Code status-line recorder. Claude Code pipes the session JSON to stdin on every
 * refresh; we append the meter part to the log (only when it changed) and print one line.
 */
export function record(stdin: string, logPath: string, opts: { then?: string; quiet?: boolean; now?: number }): string {
  let data: any = {};
  try { data = JSON.parse(stdin || '{}'); } catch { /* keep going: never break the status line */ }
  const rl = data.rate_limits ?? {};
  const snap: MeterSnapshot = {
    t: opts.now ?? Date.now(),
    session: typeof data.session_id === 'string' ? data.session_id : undefined,
    model: data.model?.id,
    version: data.version,
    fast: typeof data.fast_mode === 'boolean' ? data.fast_mode : undefined,
    ttl: data.prompt_cache?.ttl,
  };
  for (const k of ['five_hour', 'seven_day', 'spend_limit'] as const) {
    const w = rl[k];
    if (w && typeof w.used_percentage === 'number') (snap as any)[k] = { used_percentage: w.used_percentage, resets_at: w.resets_at, ...(k === 'spend_limit' ? { used_usd: w.used_usd, limit_usd: w.limit_usd } : {}) };
  }
  if (snap.five_hour || snap.seven_day || snap.spend_limit) {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      if (changed(logPath, snap)) appendFileSync(logPath, JSON.stringify(snap) + '\n');
    } catch { /* read-only home: still print */ }
  }
  let prefix = '';
  if (opts.then) {
    const r = spawnSync(opts.then, { shell: true, input: stdin, encoding: 'utf8', timeout: 4000 });
    prefix = (r.stdout || '').replace(/\s+$/, '');
  }
  if (opts.quiet) return prefix ? prefix + '\n' : '';
  const bits: string[] = [];
  const p = (n: number) => `${Math.round(n)}%`;
  if (snap.five_hour) bits.push(`5h ${p(snap.five_hour.used_percentage)}`);
  if (snap.seven_day) bits.push(`wk ${p(snap.seven_day.used_percentage)}`);
  if (snap.spend_limit) bits.push(`spend ${p(snap.spend_limit.used_percentage)}`);
  if (snap.fast) bits.push('fast');
  if (snap.ttl === '5m') bits.push('cache 5m');
  const mine = bits.length ? `⛽ ${bits.join(' · ')}` : '⛽ meter: waiting for the first reply';
  return prefix ? `${prefix} │ ${mine}\n` : `${mine}\n`;
}

function changed(logPath: string, s: MeterSnapshot): boolean {
  if (!existsSync(logPath)) return true;
  try {
    const size = statSync(logPath).size;
    const fd = readFileSync(logPath, 'utf8');
    void size;
    const lines = fd.trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 40; i--) {
      const prev = JSON.parse(lines[i]) as MeterSnapshot;
      if (prev.session !== s.session) continue;
      const same = prev.five_hour?.used_percentage === s.five_hour?.used_percentage && prev.seven_day?.used_percentage === s.seven_day?.used_percentage
        && prev.five_hour?.resets_at === s.five_hour?.resets_at && prev.seven_day?.resets_at === s.seven_day?.resets_at && prev.spend_limit?.used_percentage === s.spend_limit?.used_percentage;
      // unchanged readings are kept at most every 10 minutes (enough to prove "it stayed put")
      return !same || s.t - prev.t >= 10 * 60_000;
    }
  } catch { return true; }
  return true;
}
