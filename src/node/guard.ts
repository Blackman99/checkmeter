import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseCodexRollout } from '../core/codex.js';
import { parseClaudeMeterLog } from '../core/claude.js';
import type { Reading } from '../core/types.js';
import { fmtWhen } from '../core/analyse.js';

function tail(p: string, bytes = 512 * 1024): string {
  const fd = openSync(p, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const s = buf.toString('utf8');
    return start > 0 ? s.slice(s.indexOf('\n') + 1) : s;
  } finally { closeSync(fd); }
}

/** newest rollout file under sessions/ (only looks at the last 3 day folders, so it stays fast) */
export function newestRollout(codexHome: string, now = Date.now()): string | undefined {
  let best: string | undefined; let bestM = 0;
  for (let d = 0; d < 3; d++) {
    const t = new Date(now - d * 86_400_000);
    const dir = join(codexHome, 'sessions', String(t.getFullYear()), String(t.getMonth() + 1).padStart(2, '0'), String(t.getDate()).padStart(2, '0'));
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const m = statSync(join(dir, f)).mtimeMs;
      if (m > bestM) { bestM = m; best = join(dir, f); }
    }
  }
  return best;
}

export interface Latest { harness: 'codex' | 'claude'; five?: Reading; week?: Reading }

export function latestReadings(opts: { codexHome: string; meterLog: string; prefer?: 'codex' | 'claude'; now?: number }): Latest[] {
  const out: Latest[] = [];
  const pick = (rs: Reading[], harness: 'codex' | 'claude') => {
    const five = [...rs].reverse().find((r) => r.window === '5h');
    const week = [...rs].reverse().find((r) => r.window === 'week');
    if (five || week) out.push({ harness, five, week });
  };
  if (opts.prefer !== 'claude') {
    const f = newestRollout(opts.codexHome, opts.now);
    if (f) pick(parseCodexRollout(tail(f), f).readings, 'codex');
  }
  if (opts.prefer !== 'codex' && existsSync(opts.meterLog)) pick(parseClaudeMeterLog(tail(opts.meterLog, 64 * 1024), opts.meterLog).readings, 'claude');
  return out;
}

/** Returns the block message, or undefined when the agent may continue. */
export function guardCheck(latest: Latest[], max5h: number, maxWeek: number, now = Date.now()): string | undefined {
  for (const l of latest) {
    const name = l.harness === 'codex' ? 'Codex' : 'Claude Code';
    for (const [r, max, label] of [[l.five, max5h, '5-hour'], [l.week, maxWeek, 'weekly']] as const) {
      if (!r) continue;
      if (r.resetsAt && r.resetsAt <= now) continue; // window has rolled over since that reading
      if (now - r.t > 6 * 3_600_000) continue; // too old to act on
      if (r.usedPercent >= max) {
        const mins = r.resetsAt ? Math.round((r.resetsAt - now) / 60_000) : undefined;
        const when = r.resetsAt ? ` It resets ${fmtWhen(r.resetsAt)}${mins != null ? ` (in ${mins >= 120 ? Math.round(mins / 60) + ' h' : mins + ' min'})` : ''}.` : '';
        return `checkmeter guard: the ${name} ${label} meter is at ${Math.round(r.usedPercent)}% (guard line ${max}%).${when} Stop here and tell the user how far the task got, or ask them to raise --max-${label === '5-hour' ? '5h' : 'week'}.`;
      }
    }
  }
  return undefined;
}
