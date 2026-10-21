import { homedir } from 'node:os';
import type { Finding, Report, SessionRow } from '../core/analyse.js';
import { fmtPct, fmtTok, fmtWhen } from '../core/analyse.js';
import type { Paint } from './color.js';
import { padEnd, padStart, vis } from './color.js';

const KIND_LABEL: Record<string, string> = {
  OFF_LEDGER: 'OFF-LEDGER', FAST_METER: 'FAST METER', STUCK_RESET: 'STUCK RESET', PLAN_CHANGED: 'PLAN CHANGED',
  METER_DROP: 'METER DROP', LIMIT_HIT: 'LIMIT HIT', CACHE_TTL: 'CACHE TTL', NO_METER: 'NO METER', NO_BASELINE: 'NO BASELINE',
};

export function tildify(p: string | undefined): string {
  if (!p) return '';
  const h = homedir();
  return p.startsWith(h) ? '~' + p.slice(h.length) : p;
}

/** last two folders of the session's cwd: /Users/me/code/api → code/api */
function projName(p: string | undefined): string {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  const s = parts.slice(-2).join('/');
  return s.length > 14 ? '…' + s.slice(s.length - 13) : s;
}
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function fmtShort(t: number): string { const d = new Date(t); return `${WD[d.getDay()]} ${String(d.getDate()).padStart(2, ' ')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

/** word-wrap to the terminal; `style` is applied per line so a colour never bleeds into, or drops off, a continuation line */
function wrap(text: string, width: number, indent: string, style?: (s: string) => string): string[] {
  const lead = (text.match(/^ */) || [''])[0];
  const words = text.slice(lead.length).split(' ');
  words[0] = lead + words[0];
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && vis(cur) + 1 + vis(w) > width) { lines.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.map((l, i) => (i === 0 ? '' : indent) + (style ? style(l) : l));
}

/** rollout-2026-10-17T10-02-00-034814c2-….jsonl → rollout-…034814c2.jsonl; keeps the folder so it stays findable */
export function shortFile(p: string): string {
  return tildify(p).replace(/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8})[0-9a-f-]*\.jsonl/i, 'rollout-…$1.jsonl');
}

export function fileRef(f: Finding): string | undefined {
  if (!f.readings.length) return undefined;
  const a = f.readings[0]; const b = f.readings[f.readings.length - 1];
  if (a.file === b.file) return a.line === b.line ? `${shortFile(a.file)}:${a.line}` : `${shortFile(a.file)}:${a.line} → :${b.line}`;
  return `${shortFile(a.file)}:${a.line} → ${shortFile(b.file).split('/').pop()}:${b.line}`;
}

export interface RenderOptions { width: number; top: number; days: number; paint: Paint; demo?: boolean }

export function renderReport(r: Report, o: RenderOptions): string {
  const P = o.paint;
  const W = Math.max(72, Math.min(o.width, 132));
  const out: string[] = [];
  const range = `${fmtWhen(r.since)} → ${fmtWhen(r.now)}`;
  out.push(`${P.head('checkmeter')} ${P.dim(r.version)}  ·  last ${o.days} day${o.days === 1 ? '' : 's'}  ·  ${P.dim(range)}${o.demo ? '  ·  ' + P.review('DEMO DATA (generated, not a real account)') : ''}`);
  for (const h of r.harnesses) {
    if (!h.events && !h.readings) { out.push(`${P.dim(padEnd(h.harness, 7))}${P.dim(h.harness === 'codex' ? 'no Codex sessions in this period (looked in ~/.codex/sessions)' : 'no Claude Code transcripts in this period (looked in ~/.claude/projects)')}`); continue; }
    const meter = h.readings ? `${h.readings.toLocaleString('en-US')} meter reading${h.readings === 1 ? '' : 's'}${h.harness === 'claude' ? ' (recorded)' : ''}` : P.dim('no meter readings');
    const plan = h.plans.length ? `  ·  plan${h.plans.length > 1 ? 's in readings' : ''} ${h.plans.join(', ')}` : '';
    out.push(`${padEnd(P.bold(h.harness), 7)}${h.sessions} session${h.sessions === 1 ? '' : 's'}  ·  ${h.events.toLocaleString('en-US')} requests  ·  ${fmtTok(h.weighted)} weighted tokens  ·  ${meter}${plan}`);
  }
  out.push('');

  const flagged = r.findings.filter((f) => f.severity !== 'note');
  const notes = r.findings.filter((f) => f.severity === 'note');
  if (flagged.length) {
    out.push(P.bold(`READINGS THAT DON'T ADD UP  ${P.dim(`(${flagged.length})`)}`));
  } else if (r.harnesses.some((h) => h.readings)) {
    out.push(`${P.ok('✓')} ${P.bold('every meter reading adds up')} ${P.dim('— each rise matches the tokens your own sessions logged')}`);
  }
  const labelW = 14;
  const indent = ' '.repeat(3 + labelW);
  for (const f of [...flagged, ...notes]) {
    const sym = f.severity === 'flag' ? P.flag('✖') : f.severity === 'review' ? P.review('◆') : P.dim('·');
    const lab = KIND_LABEL[f.kind] ?? f.kind;
    const labC = f.severity === 'flag' ? P.flag(padEnd(lab, labelW)) : f.severity === 'review' ? P.review(padEnd(lab, labelW)) : P.dim(padEnd(lab, labelW));
    const title = `${P.dim(f.harness + ' ·')} ${f.severity === 'note' ? P.dim(f.title) : f.title}`;
    out.push(...wrap(` ${sym} ${labC}${title}`, W, indent));
    for (const d of f.detail) out.push(...wrap(indent + d, W, indent, P.dim));
    const ref = fileRef(f);
    if (ref && f.severity !== 'note') out.push(...wrap(indent + '↳ ' + ref, W, indent + '  ', P.dim));
  }
  if (flagged.length || notes.length) out.push('');

  for (const h of ['codex', 'claude'] as const) {
    const rows = r.sessions.filter((s) => s.harness === h);
    if (!rows.length) continue;
    const hasMeter = r.series.some((s) => s.harness === h);
    out.push(P.bold(`WHERE THE METER WENT  ${P.dim(`${h} · ${hasMeter ? 'meter points per session (5h / week)' : 'weighted tokens per session (no meter readings)'}`)}`));
    const head = `  ${padEnd('session', 10)}${padEnd('project', 15)}${padEnd('started', 14)}${padStart(hasMeter ? '5h pts' : '', 7)}${padStart(hasMeter ? 'wk pts' : '', 7)}${padStart('weighted', 10)}  ${padEnd('model', 14)}why`;
    out.push(P.dim(head));
    const shown = rows.slice(0, o.top);
    for (const s of shown) out.push(sessionLine(s, hasMeter, P, W));
    if (rows.length > shown.length) {
      const rest = rows.slice(shown.length);
      const d5 = rest.reduce((a, s) => a + s.d5h, 0), dw = rest.reduce((a, s) => a + s.dWeek, 0), wt = rest.reduce((a, s) => a + s.weighted, 0);
      const anyMetered = hasMeter && rest.some((s) => s.metered !== false);
      out.push(P.dim(`  ${padEnd(`+${rest.length} more`, 39)}${padStart(!hasMeter ? '' : anyMetered ? d5.toFixed(1) : '—', 7)}${padStart(!hasMeter ? '' : anyMetered ? dw.toFixed(1) : '—', 7)}${padStart(fmtTok(wt), 10)}  ${P.dim('--top ' + rows.length + ' to list all')}`));
    }
    if (hasMeter) {
      const s5 = r.series.filter((s) => s.harness === h && s.window === '5h').reduce((a, s) => a + s.unexplained, 0);
      const sw = r.series.filter((s) => s.harness === h && s.window === 'week').reduce((a, s) => a + s.unexplained, 0);
      if (s5 > 0.05 || sw > 0.05) out.push(`  ${padEnd(P.flag('not from any session on this machine'), 39)}${padStart(P.flag(s5.toFixed(1)), 7)}${padStart(P.flag(sw.toFixed(1)), 7)}`);
      const last5 = r.series.find((s) => s.harness === h && s.window === '5h')?.last;
      const lastW = r.series.find((s) => s.harness === h && s.window === 'week')?.last;
      const bits: string[] = [];
      if (last5) bits.push(`5h ${fmtPct(last5.usedPercent)}${last5.resetsAt ? ` (resets ${fmtWhen(last5.resetsAt)})` : ''}`);
      if (lastW) bits.push(`week ${fmtPct(lastW.usedPercent)}${lastW.resetsAt ? ` (resets ${fmtWhen(lastW.resetsAt)})` : ''}`);
      if (bits.length) out.push(P.dim(`  last reading ${fmtWhen(Math.max(last5?.t ?? 0, lastW?.t ?? 0))}: ${bits.join(' · ')}`));
    }
    out.push('');
  }

  const anyFlag = flagged.length > 0;
  out.push(P.dim('next  ') + (anyFlag ? `checkmeter evidence -o meter-evidence.md  ${P.dim('write the flagged readings up for a support ticket')}` : `checkmeter --days 30  ${P.dim('look further back')}`));
  if (r.findings.some((f) => f.kind === 'NO_METER')) out.push(P.dim('      ') + `checkmeter setup claude  ${P.dim('start recording the Claude Code meter from the status line')}`);
  out.push(P.dim('      ') + `checkmeter --json  ${P.dim('the same report for scripts')}`);
  return out.join('\n') + '\n';
}

function sessionLine(s: SessionRow, hasMeter: boolean, P: Paint, W: number): string {
  const id = s.id.replace(/^.*?([0-9a-f]{8})[0-9a-f-]*$/i, '$1').slice(0, 8);
  const proj = projName(s.cwd) || P.dim('—');
  const when = s.firstAt ? fmtShort(s.firstAt) : '';
  const unm = hasMeter && s.metered === false;
  const v5 = !hasMeter ? '' : unm ? P.dim('—') : s.d5h >= 0.05 ? s.d5h.toFixed(1) : P.dim('0');
  const vw = !hasMeter ? '' : unm ? P.dim('—') : s.dWeek >= 0.05 ? s.dWeek.toFixed(1) : P.dim('0');
  const model = (s.model ?? '?').replace(/^claude-/, '').slice(0, 13);
  const why = unm ? 'before the meter was recorded' : s.causes.slice(0, 2).join(' · ');
  const base = `  ${padEnd(id + (s.subagent ? P.dim('↳') : ''), 10)}${padEnd(proj, 15)}${padEnd(when, 14)}${padStart(v5, 7)}${padStart(vw, 7)}${padStart(fmtTok(s.weighted), 10)}  ${padEnd(model, 14)}`;
  const room = W - vis(base);
  const whyT = why.length > room ? why.slice(0, Math.max(0, room - 1)) + '…' : why;
  return base + P.dim(whyT);
}
