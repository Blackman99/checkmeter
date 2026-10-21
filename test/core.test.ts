import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodexRollout } from '../src/core/codex.js';
import { parseClaudeTranscript, parseClaudeMeterLog } from '../src/core/claude.js';
import { analyse, dedupe } from '../src/core/analyse.js';
import { mergeSources } from '../src/core/types.js';
import { buildDemo } from '../src/node/demo.js';
import { scan } from '../src/node/scan.js';
import { renderEvidence } from '../src/node/evidence.js';
import { record } from '../src/node/record.js';
import { guardCheck, latestReadings } from '../src/node/guard.js';
import { planClaudeSetup, applySetup, guardSnippet } from '../src/node/setup.js';

const H = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();
const tc = (t: number, last: any, total: any, rl: any) => JSON.stringify({ timestamp: iso(t), type: 'event_msg', payload: { type: 'token_count', info: last ? { last_token_usage: last, total_token_usage: total, model_context_window: 272000 } : null, rate_limits: rl } });
const rl = (p: number, w: number, r5: number, rw: number, plan = 'pro') => ({ limit_id: 'codex', primary: { used_percent: p, window_minutes: 300, resets_at: r5 / 1000 }, secondary: { used_percent: w, window_minutes: 10080, resets_at: rw / 1000 }, plan_type: plan });

test('codex rollout: tokens, meter readings, duplicate snapshots counted once', () => {
  const t0 = Date.parse('2026-10-20T01:00:00Z');
  const u = { input_tokens: 100_000, cached_input_tokens: 80_000, output_tokens: 2_000, reasoning_output_tokens: 1_000, total_tokens: 102_000 };
  const lines = [
    JSON.stringify({ timestamp: iso(t0), type: 'session_meta', payload: { id: '019a0000-1111-7222-a333-444455556666', cwd: '/w/api', cli_version: '0.151.0', source: 'cli' } }),
    JSON.stringify({ timestamp: iso(t0), type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }),
    JSON.stringify({ timestamp: iso(t0), type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'priority' } } }),
    tc(t0 + 60_000, u, u, rl(10, 40, t0 + 5 * H, t0 + 100 * H)),
    tc(t0 + 61_000, u, u, rl(10, 40, t0 + 5 * H, t0 + 100 * H)), // re-emitted, same totals
    '{"timestamp": "broken',
  ];
  const p = parseCodexRollout(lines.join('\n'), '/x/rollout-2026-10-20T01-00-00-019a0000-1111-7222-a333-444455556666.jsonl');
  assert.equal(p.events.length, 1);
  assert.equal(p.badLines, 1);
  const e = p.events[0];
  assert.equal(e.model, 'gpt-6.1-sol');
  assert.equal(e.tier, 'priority');
  assert.equal(e.input, 20_000);
  assert.equal(e.cacheRead, 80_000);
  assert.equal(e.weighted, 20_000 + 8_000 + 16_000);
  assert.equal(p.readings.length, 4); // 2 windows × 2 lines (dedupe happens in analyse)
  assert.equal(dedupe(mergeSources([p, p])).readings.length, 4, 'the same file seen twice adds nothing');
  assert.deepEqual(p.readings.map((r) => r.window).slice(0, 2), ['5h', 'week']);
  assert.equal(p.readings[0].plan, 'pro');
  assert.equal(p.readings[0].line, 4);
  assert.equal(p.sessions[0].cwd, '/w/api');
});

test('claude transcript: streamed copies count once, TTL split, subagent ids stay separate', () => {
  const rec = (id: string, t: string, u: any, extra: any = {}) => JSON.stringify({ type: 'assistant', sessionId: 'aaaaaaaa-1111-4222-8333-444455556666', timestamp: t, version: '2.1.304', requestId: 'req_' + id, message: { id, model: 'claude-opus-5-5', usage: u }, ...extra });
  const u = { input_tokens: 10, cache_creation_input_tokens: 50_000, cache_read_input_tokens: 0, output_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 50_000, ephemeral_1h_input_tokens: 0 }, speed: 'fast' };
  const text = [rec('m1', '2026-10-20T01:00:00Z', u), rec('m1', '2026-10-20T01:00:00Z', u), rec('m2', '2026-10-20T01:10:00Z', { ...u, cache_creation: undefined, speed: undefined })].join('\n');
  const p = parseClaudeTranscript(text, '/c/projects/p/aaaaaaaa-1111-4222-8333-444455556666.jsonl');
  assert.equal(p.events.length, 2);
  assert.equal(p.events[0].cacheWrite5m, 50_000);
  assert.equal(p.events[0].tier, 'fast');
  assert.equal(p.events[1].cacheWrite5m, 50_000, 'no TTL split → counted as 5-minute writes');
  const sub = parseClaudeTranscript(text, '/c/projects/p/aaaaaaaa-1111-4222-8333-444455556666/subagents/agent-1a2b3c4d.jsonl');
  assert.notEqual(sub.events[0].session, p.events[0].session);
  assert.equal(sub.events[0].sidechain, true);
  const log = parseClaudeMeterLog(JSON.stringify({ t: 1, five_hour: { used_percentage: 12.5, resets_at: 100 }, seven_day: { used_percentage: 40, resets_at: 200 } }), '/m.jsonl');
  assert.deepEqual(log.readings.map((r) => [r.window, r.usedPercent, r.resetsAt]), [['5h', 12.5, 100_000], ['week', 40, 200_000]]);
});

const NOW = Date.parse('2026-10-21T02:30:00Z');

function demoReport() {
  const home = mkdtempSync(join(tmpdir(), 'cm-demo-'));
  buildDemo(home, NOW);
  const res = scan({ since: NOW - 7 * 24 * H, home });
  return { home, res, report: analyse(res.source, { now: NOW, since: NOW - 7 * 24 * H, version: 'test' }) };
}

test('demo home: every planted incident is found, nothing else is flagged', () => {
  const { report } = demoReport();
  const kinds = report.findings.map((f) => f.kind).sort();
  assert.deepEqual([...new Set(kinds)], ['CACHE_TTL', 'FAST_METER', 'LIMIT_HIT', 'METER_DROP', 'OFF_LEDGER', 'PLAN_CHANGED', 'STUCK_RESET']);
  const fast = report.findings.filter((f) => f.kind === 'FAST_METER');
  assert.equal(fast.length, 1, 'one merged FAST METER finding (5h + week)');
  assert.ok(fast[0].ratio! > 2 && fast[0].ratio! < 3, `ratio ${fast[0].ratio}`);
  assert.equal(fast[0].severity, 'flag');
  const off = report.findings.filter((f) => f.kind === 'OFF_LEDGER');
  assert.equal(off.length, 1);
  assert.ok(Math.abs(off[0].delta! - 11) <= 1.5, `off-ledger delta ${off[0].delta}`);
  const drop = report.findings.find((f) => f.kind === 'METER_DROP')!;
  assert.ok(Math.abs(drop.delta! + 12) <= 1);
  const plan = report.findings.filter((f) => f.kind === 'PLAN_CHANGED');
  assert.equal(plan.length, 1, 'pro → plus → pro is one finding');
  assert.match(plan[0].title, /meter used "plus" limits for \d+ h, between "pro" readings/);
  assert.match(plan[0].detail.join(' '), /same stretch as the FAST METER finding/);
  // the Claude side adds up: no FAST/OFF/STUCK for claude
  assert.equal(report.findings.filter((f) => f.harness === 'claude' && f.severity === 'flag' && f.kind !== 'CACHE_TTL').length, 0);
});

test('subagent replay is not double counted', () => {
  const { res } = demoReport();
  const withDup = res.source.events.length;
  const after = dedupe(res.source).events.length;
  assert.equal(withDup - after, 12, 'the child rollout replays 12 parent token_count events');
});

test('a steady week has nothing to flag', () => {
  const t0 = NOW - 7 * 24 * H;
  const lines: string[] = [JSON.stringify({ timestamp: iso(t0), type: 'session_meta', payload: { id: '019a0000-aaaa-7222-a333-444455556666', cwd: '/w' } }), JSON.stringify({ timestamp: iso(t0), type: 'turn_context', payload: { model: 'gpt-6.1-sol' } })];
  let u5 = 0, uw = 0, r5 = 0, tot = 0;
  for (let d = 0; d < 6; d++) for (let i = 0; i < 60; i++) {
    const t = t0 + d * 24 * H + 9 * H + i * 90_000;
    const last = { input_tokens: 100_000, cached_input_tokens: 85_000, output_tokens: 3000, reasoning_output_tokens: 1500, total_tokens: 103_000 };
    tot += 103_000;
    const w = 15_000 + 8_500 + 24_000;
    if (t >= r5) { u5 = 0; r5 = t + 5 * H; }
    u5 += w / 1e6 * 10; uw += w / 1e6 * 0.8;
    lines.push(tc(t, last, { ...last, total_tokens: tot }, rl(Math.round(u5), Math.round(uw), r5, t0 + 7 * 24 * H + H)));
  }
  const src = parseCodexRollout(lines.join('\n'), '/x/rollout-a.jsonl');
  const rep = analyse(src, { now: NOW, since: t0 });
  assert.deepEqual(rep.findings.filter((f) => f.severity !== 'note').map((f) => f.title), []);
  assert.ok(rep.series.find((s) => s.window === 'week')!.baseline! > 0.6);
  assert.ok(rep.sessions[0].dWeek > 10);
});

test('evidence markdown carries readings, file:line and a way to check them', () => {
  const { report } = demoReport();
  const md = renderEvidence(report, { demo: true });
  assert.match(md, /DEMO DATA/);
  assert.match(md, /\| 1 \| /);
  assert.match(md, /sed -n '\d+p' .*rollout-.*\.jsonl.*jq/);
  assert.match(md, /OFF-LEDGER/);
  assert.doesNotMatch(md, /content/);
});

test('record: appends changed readings, keeps unchanged ones out, chains an old status line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-rec-'));
  const log = join(dir, 'm', 'claude-meter.jsonl');
  const input = JSON.stringify({ session_id: 's1', model: { id: 'claude-opus-5-5' }, version: '2.1.305', fast_mode: false, prompt_cache: { ttl: '5m' }, rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1000 }, seven_day: { used_percentage: 41.2, resets_at: 2000 } } });
  const line = record(input, log, { now: 1_000_000 });
  assert.equal(line, '⛽ 5h 24% · wk 41% · cache 5m\n');
  record(input, log, { now: 1_060_000 });
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1, 'unchanged within 10 min → not appended');
  record(input.replace('23.5', '25'), log, { now: 1_120_000 });
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
  const chained = record(input, log, { then: "printf 'my line'", now: 1_200_000 });
  assert.equal(chained, 'my line │ ⛽ 5h 24% · wk 41% · cache 5m\n');
  assert.equal(record('not json', log, {}), '⛽ meter: waiting for the first reply\n');
});

test('guard: blocks over the line, lets go after the window resets', () => {
  const now = NOW;
  const r = (used: number, resetsIn: number) => ({ harness: 'codex' as const, t: now - 60_000, window: '5h' as const, usedPercent: used, resetsAt: now + resetsIn, file: 'f', line: 1 });
  assert.match(guardCheck([{ harness: 'codex', five: r(93, 38 * 60_000) }], 90, 95, now)!, /Codex 5-hour meter is at 93% \(guard line 90%\).*in 38 min/);
  assert.equal(guardCheck([{ harness: 'codex', five: r(93, -60_000) }], 90, 95, now), undefined);
  assert.equal(guardCheck([{ harness: 'codex', five: r(80, 60_000) }], 90, 95, now), undefined);
  const { home } = demoReport();
  const latest = latestReadings({ codexHome: join(home, '.codex'), meterLog: join(home, '.checkmeter', 'claude-meter.jsonl'), now: NOW });
  assert.ok(latest.some((l) => l.harness === 'codex' && l.five));
  assert.ok(latest.some((l) => l.harness === 'claude' && l.week));
});

test('setup: wraps an existing status line and keeps a backup', () => {
  const home = mkdtempSync(join(tmpdir(), 'cm-setup-'));
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: "~/.claude/statusline.sh 'x'" } }));
  const old = process.env.CLAUDE_CONFIG_DIR; delete process.env.CLAUDE_CONFIG_DIR;
  const plan = planClaudeSetup(home);
  assert.equal(plan.after.statusLine.command, `checkmeter record --then '~/.claude/statusline.sh '\\''x'\\'''`);
  assert.equal(plan.after.model, 'opus');
  const backup = applySetup(plan, NOW)!;
  assert.ok(existsSync(backup));
  assert.equal(planClaudeSetup(home).already, true);
  assert.match(guardSnippet('codex', 90, 95), /\[\[hooks\.PreToolUse\.hooks\]\]/);
  assert.throws(() => guardSnippet('vim', 90, 95));
  if (old) process.env.CLAUDE_CONFIG_DIR = old;
  void readdirSync;
});

test('mergeSources keeps everything', () => {
  const a = parseClaudeMeterLog('{"t":1,"five_hour":{"used_percentage":1}}', 'a');
  const b = parseClaudeMeterLog('{"t":2,"five_hour":{"used_percentage":2}}', 'b');
  assert.equal(mergeSources([a, b]).readings.length, 2);
});
