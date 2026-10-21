import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Build a demo home with realistic Codex rollouts, Claude Code transcripts and a
 * recorder log. The file formats match what the harnesses write; the account,
 * numbers and incidents are invented so every verdict has something to show.
 */
export interface DemoInfo { home: string; now: number; since: number }

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function uuid(r: () => number, prefix = '') {
  const h = (n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
  const id = `${h(8)}-${h(4)}-7${h(3)}-a${h(3)}-${h(12)}`;
  return prefix ? prefix + id.slice(prefix.length) : id;
}

const iso = (t: number) => new Date(t).toISOString();
function localMidnight(t: number) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function stamp(t: number) { const d = new Date(t); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`; }
function dayDir(t: number) { const d = new Date(t); const p = (n: number) => String(n).padStart(2, '0'); return join(String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate())); }


export function buildDemo(home: string, now = Date.now()): DemoInfo {
  rmSync(home, { recursive: true, force: true });
  const r = rng(20261021);
  const today = localMidnight(now);
  const D = (n: number, h: number, mi = 0) => today - n * DAY + h * HOUR + mi * MIN;

  // ======================= Codex =======================
  // 1) plan every session's requests, 2) run the vendor meter over all requests in time
  // order (sessions overlap, the meter is one pool), 3) write the rollout files.
  interface CReq { t: number; input: number; cached: number; output: number; reasoning: number; w: number; compactAfter: boolean; line?: string }
  interface CSess { id: string; start: number; cwd: string; model: string; reqs: CReq[]; replay?: CSess; tier?: string; extra: { t: number; line: () => string }[] }
  const csess: CSess[] = [];
  const planCodex = (start: number, o: { cwd: string; n: number; every: number; ctx0: number; growth: number; model?: string; replay?: CSess }) => {
    const s: CSess = { id: uuid(r), start, cwd: o.cwd.replace('~', '/Users/demo'), model: o.model ?? 'gpt-6.1-sol', reqs: [], replay: o.replay, extra: [] };
    let t = start + 30_000; let ctx = o.ctx0;
    for (let i = 0; i < o.n; i++) {
      t += o.every * (0.6 + r() * 0.8);
      if (t > now - 4 * MIN) break;
      ctx = Math.min(ctx + o.growth * (0.5 + r()), 258_000);
      const input = Math.round(ctx);
      const cached = Math.round(ctx * (0.8 + r() * 0.14));
      const reasoning = Math.round(600 + r() * 3200);
      const output = reasoning + Math.round(300 + r() * 1600);
      const compactAfter = ctx > 236_000 && r() < 0.5;
      s.reqs.push({ t, input, cached, output, reasoning, w: (input - cached) + cached * 0.1 + output * 8, compactAfter });
      if (compactAfter) ctx = 50_000;
    }
    csess.push(s);
    return s;
  };
  const repos = ['~/code/api', '~/code/web', '~/code/infra', '~/code/mobile'];
  const week: [number, number, number, number, number, number][] = [
    // daysAgo, hour, min, repo, requests, growth
    [6, 9, 12, 0, 70, 2200], [6, 14, 5, 1, 55, 1600],
    [5, 9, 40, 2, 75, 2600], [5, 15, 10, 0, 50, 1400],
    [4, 10, 2, 1, 70, 2400], [4, 16, 30, 3, 45, 1500],
    [3, 10, 20, 0, 75, 2600], [3, 15, 0, 2, 40, 1300],
    [2, 9, 30, 1, 65, 2000], [2, 14, 40, 3, 40, 1200],
  ];
  for (const [d, h, mi, ri, n, g] of week) planCodex(D(d, h, mi), { cwd: repos[ri], n, every: 95_000, ctx0: 30_000, growth: g });
  const morning = planCodex(D(1, 6, 30), { cwd: '~/code/api', n: 150, every: 55_000, ctx0: 90_000, growth: 3400 });
  planCodex(D(1, 12, 10), { cwd: '~/code/web', n: 30, every: 80_000, ctx0: 30_000, growth: 1800 });
  const parent = planCodex(D(1, 16, 40), { cwd: '~/code/web', n: 40, every: 80_000, ctx0: 30_000, growth: 2000 });
  const child = planCodex(D(1, 17, 0), { cwd: '~/code/web', n: 25, every: 60_000, ctx0: 50_000, growth: 2600, replay: parent });
  planCodex(Math.min(D(0, 1, 25), now - 70 * MIN), { cwd: '~/code/api', n: 14, every: 60_000, ctx0: 30_000, growth: 1500 });
  void morning;

  // the vendor's meter, one pool for the account
  const R5 = 11, RW = 0.62;
  const wrong = (t: number) => t >= D(4, 0) && t < D(2, 0); // "wrong plan applied": 2.6x, readings say plus
  const offAt = D(1, 13, 5), offUntil = D(1, 16, 40); // a cloud task burns 11 pts of 5h, 3.5 of week
  const creditAt = D(0, 1, 10);
  const all = csess.flatMap((s) => s.reqs.map((q) => ({ s, q }))).sort((a, b) => a.q.t - b.q.t);
  const m = { u5: 0, r5: 0, uw: 18, rw: D(6, 8) + 7 * DAY };
  let offDone = false, creditDone = false, stuckDone = false;
  let lastT = 0;
  for (const { q } of all) {
    // window due to roll over, but the vendor keeps the old one for 22 minutes (yesterday morning only)
    if (!stuckDone && m.r5 && q.t >= m.r5 && m.r5 > D(1, 6) && m.r5 < D(1, 13)) {
      stuckDone = true;
      const due = m.r5;
      const stuckS: CSess = { id: uuid(r), start: due - 9 * MIN, cwd: '/Users/demo/code/api', model: 'gpt-6.1-sol', reqs: [], extra: [] };
      const used = Math.round(m.u5), usedW = Math.round(m.uw);
      for (let k = 0; k < 6; k++) {
        const t = due - 4 * MIN + k * 5 * MIN;
        stuckS.extra.push({ t, line: () => JSON.stringify({ timestamp: iso(t), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: used, window_minutes: 300, resets_at: Math.round(due / 1000) }, secondary: { used_percent: usedW, window_minutes: 10080, resets_at: Math.round(m.rw / 1000) }, plan_type: 'pro', rate_limit_reached_type: 'rate_limit_reached' } } }) });
      }
      csess.push(stuckS);
      m.r5 = due + 22 * MIN; // finally rolls over
    }
    if (q.t >= m.r5) { m.u5 = 0; m.r5 = q.t + 5 * HOUR; }
    if (!offDone && lastT < offUntil && q.t >= offUntil) { offDone = true; m.u5 = Math.min(100, m.u5 + 11); m.uw += 3.5; }
    if (!creditDone && q.t >= creditAt) { creditDone = true; m.uw = Math.max(0, m.uw - 12); }
    void offAt;
    const f = wrong(q.t) ? 2.6 : 1;
    m.u5 = Math.min(100, m.u5 + (q.w / 1e6) * R5 * f);
    m.uw = Math.min(100, m.uw + (q.w / 1e6) * RW * f);
    lastT = q.t;
    const rl = { limit_id: 'codex', primary: { used_percent: Math.round(m.u5), window_minutes: 300, resets_at: Math.round(m.r5 / 1000) }, secondary: { used_percent: Math.round(m.uw), window_minutes: 10080, resets_at: Math.round(m.rw / 1000) }, credits: { has_credits: false, unlimited: false, balance: null }, plan_type: wrong(q.t) ? 'plus' : 'pro' };
    (q as any).rl = rl;
  }
  // serialise
  const codex = join(home, '.codex', 'sessions');
  for (const s of csess) {
    const lines: { t: number; line: string }[] = [];
    lines.push({ t: s.start, line: JSON.stringify({ timestamp: iso(s.start), type: 'session_meta', payload: { id: s.id, timestamp: iso(s.start), cwd: s.cwd, originator: 'codex_cli_rs', cli_version: '0.151.0', source: s.replay ? { subagent: { thread_spawn: { parent_thread_id: s.replay.id, depth: 1 } } } : 'cli', model_provider: 'openai' } }) });
    if (s.replay) for (const l of rolloutLines(s.replay).slice(0, 12)) lines.push({ t: s.start + 1, line: l.line }); // replayed parent history
    lines.push({ t: s.start + 500, line: JSON.stringify({ timestamp: iso(s.start + 500), type: 'turn_context', payload: { cwd: s.cwd, model: s.model, effort: 'high', approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' } } }) });
    if (s.replay) lines.push({ t: s.start + 600, line: JSON.stringify({ timestamp: iso(s.start + 600), type: 'event_msg', payload: { type: 'task_started' } }) });
    for (const l of rolloutLines(s)) lines.push(l);
    for (const e of s.extra) lines.push({ t: e.t, line: e.line() });
    const body = lines.map((l) => l.line);
    const last = Math.max(...lines.map((l) => l.t));
    const dir = join(codex, dayDir(s.start)); mkdirSync(dir, { recursive: true });
    const p = join(dir, `rollout-${stamp(s.start)}-${s.id}.jsonl`);
    writeFileSync(p, body.join('\n') + '\n');
    utimesSync(p, new Date(last), new Date(last));
  }
  void child;

  // ======================= Claude Code =======================
  interface KReq { t: number; sid: string; version: string; usage: any; w: number; fast: boolean; mid: string; dup: boolean }
  const kreqs: KReq[] = [];
  const kfiles = new Map<string, { path: string; reqs: KReq[] }>();
  const cproj = join(home, '.claude', 'projects', '-Users-demo-code-site');
  const planClaude = (start: number, version: string, o: { turns: number; ttl: '1h' | '5m'; idleEvery?: number; fast?: boolean; parent?: string }) => {
    const sid = o.parent ?? uuid(r);
    const path = o.parent ? join(cproj, o.parent, 'subagents', `agent-${uuid(r).slice(0, 8)}.jsonl`) : join(cproj, `${sid}.jsonl`);
    const f = { path, reqs: [] as KReq[] }; kfiles.set(path, f);
    let t = start; let ctx = 16_000; let warm = false;
    for (let i = 0; i < o.turns; i++) {
      const idle = !!o.idleEvery && i > 0 && i % o.idleEvery === 0;
      t += idle ? (12 + r() * 25) * MIN : (40 + r() * 80) * 1000;
      if (t > now - 3 * MIN) break;
      ctx += 1500 + r() * 2400;
      const cold = !warm || (idle && o.ttl === '5m') || (idle && t > 0 && false);
      const write = cold ? Math.round(ctx) : Math.round(1800 + r() * 2400);
      const read = cold ? 0 : Math.round(ctx - write);
      warm = true;
      const out = Math.round(400 + r() * 2000);
      const inp = Math.round(3 + r() * 40);
      const usage = { input_tokens: inp, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: out,
        cache_creation: o.ttl === '1h' ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write } : { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 }, service_tier: 'standard', speed: o.fast ? 'fast' : 'standard' };
      const w = inp + read * 0.1 + (o.ttl === '1h' ? write * 2 : write * 1.25) + out * 5;
      const q: KReq = { t, sid, version, usage, w, fast: !!o.fast, mid: 'msg_' + uuid(r).replace(/-/g, '').slice(0, 24), dup: r() < 0.3 };
      f.reqs.push(q); kreqs.push(q);
    }
    return sid;
  };
  planClaude(D(6, 10, 15), '2.1.299', { turns: 60, ttl: '1h', idleEvery: 20 });
  planClaude(D(5, 11, 0), '2.1.300', { turns: 70, ttl: '1h', idleEvery: 15 });
  planClaude(D(4, 20, 30), '2.1.301', { turns: 80, ttl: '5m', idleEvery: 9 });
  planClaude(D(3, 10, 0), '2.1.303', { turns: 90, ttl: '5m', idleEvery: 8 });
  const main = planClaude(D(2, 14, 0), '2.1.304', { turns: 70, ttl: '5m', idleEvery: 10 });
  planClaude(D(2, 14, 20), '2.1.304', { turns: 30, ttl: '5m', fast: true, parent: main });
  planClaude(Math.min(D(0, 8, 30), now - 2 * HOUR), '2.1.305', { turns: 45, ttl: '5m', idleEvery: 12 });
  // the Claude meter (recorded by the status line from day 4 on, after `checkmeter setup claude`)
  kreqs.sort((a, b) => a.t - b.t);
  const cm = { u5: 0, r5: 0, uw: 6, rw: D(6, 10) + 7 * DAY };
  const meter: string[] = [];
  const recordFrom = D(4, 18);
  for (const q of kreqs) {
    if (q.t >= cm.r5) { cm.u5 = 0; cm.r5 = q.t + 5 * HOUR; }
    cm.u5 = Math.min(100, cm.u5 + (q.w / 1e6) * 14 * (q.fast ? 2 : 1));
    cm.uw = Math.min(100, cm.uw + (q.w / 1e6) * 1.8 * (q.fast ? 2 : 1));
    if (q.t >= recordFrom) meter.push(JSON.stringify({ t: q.t + 400, session: q.sid, model: 'claude-opus-5-5', version: q.version, fast: q.fast, ttl: q.usage.cache_creation.ephemeral_1h_input_tokens ? '1h' : '5m', five_hour: { used_percentage: Math.round(cm.u5 * 10) / 10, resets_at: Math.round(cm.r5 / 1000) }, seven_day: { used_percentage: Math.round(cm.uw * 10) / 10, resets_at: Math.round(cm.rw / 1000) } }));
  }
  for (const f of kfiles.values()) {
    const lines: string[] = [];
    for (const q of f.reqs) {
      lines.push(JSON.stringify({ type: 'user', sessionId: q.sid, timestamp: iso(q.t - 1500), cwd: '/Users/demo/code/site', version: q.version, message: { role: 'user', content: '…' } }));
      const rec = JSON.stringify({ type: 'assistant', sessionId: q.sid, timestamp: iso(q.t), cwd: '/Users/demo/code/site', version: q.version, requestId: 'req_' + q.mid.slice(4), isSidechain: f.path.includes('subagents'), message: { id: q.mid, model: 'claude-opus-5-5', role: 'assistant', usage: q.usage } });
      lines.push(rec);
      if (q.dup) lines.push(rec); // Claude Code writes some messages twice; count once
    }
    mkdirSync(join(f.path, '..'), { recursive: true });
    writeFileSync(f.path, lines.join('\n') + '\n');
    const last = f.reqs.length ? f.reqs[f.reqs.length - 1].t : now;
    utimesSync(f.path, new Date(last), new Date(last));
  }
  const meterDir = join(home, '.checkmeter'); mkdirSync(meterDir, { recursive: true });
  writeFileSync(join(meterDir, 'claude-meter.jsonl'), meter.join('\n') + '\n');
  return { home, now, since: now - 7 * DAY };

  function rolloutLines(s: CSess): { t: number; line: string }[] {
    const out: { t: number; line: string }[] = [];
    const tot = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
    for (const q of s.reqs) {
      if (!(q as any).rl) continue;
      tot.input_tokens += q.input; tot.cached_input_tokens += q.cached; tot.output_tokens += q.output; tot.reasoning_output_tokens += q.reasoning; tot.total_tokens += q.input + q.output;
      out.push({ t: q.t, line: JSON.stringify({ timestamp: iso(q.t), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { ...tot }, last_token_usage: { input_tokens: q.input, cached_input_tokens: q.cached, output_tokens: q.output, reasoning_output_tokens: q.reasoning, total_tokens: q.input + q.output }, model_context_window: 272_000 }, rate_limits: (q as any).rl } }) });
      if (q.compactAfter) out.push({ t: q.t + 2000, line: JSON.stringify({ timestamp: iso(q.t + 2000), type: 'compacted', payload: { message: '' } }) });
    }
    return out;
  }
}
