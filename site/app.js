// checkmeter landing: seven-segment LCDs, the prover can, and the in-browser analyser.
const $ = (s) => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const C = { seg: '#b6f5c8', off: '#1d3a31', bad: '#ff6b57', stuck: '#c9b8ff', ok: '#8ee3b0' };

/* ---------- seven-segment digits ---------- */
const MAP = { '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', ' ': '' };
function segPolys(x, y, w, h, t) {
  const m = y + h / 2, g = 1.5;
  const H = (yy) => `${x + t / 2 + g},${yy} ${x + t + g},${yy - t / 2} ${x + w - t - g},${yy - t / 2} ${x + w - t / 2 - g},${yy} ${x + w - t - g},${yy + t / 2} ${x + t + g},${yy + t / 2}`;
  const V = (xx, y1, y2) => `${xx},${y1 + t / 2 + g} ${xx + t / 2},${y1 + t + g} ${xx + t / 2},${y2 - t - g} ${xx},${y2 - t / 2 - g} ${xx - t / 2},${y2 - t - g} ${xx - t / 2},${y1 + t + g}`;
  return { a: H(y + t / 2), g: H(m), d: H(y + h - t / 2), f: V(x + t / 2, y, m), e: V(x + t / 2, m, y + h), b: V(x + w - t / 2, y, m), c: V(x + w - t / 2, m, y + h) };
}
function buildLcd(svg, cells = 4) {
  svg.innerHTML = '';
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('transform', 'skewX(-7) translate(10 0)');
  svg.appendChild(g);
  const parts = [];
  const W = 56, Hh = 68, T = 9, gap = 16;
  for (let i = 0; i < cells; i++) {
    const x = 6 + i * (W + gap) + (i >= cells - 1 ? 14 : 0), polys = segPolys(x, 6, W, Hh, T), cell = {};
    for (const k of 'abcdefg') {
      const p = document.createElementNS(NS, 'polygon');
      p.setAttribute('points', polys[k]); p.setAttribute('fill', C.off);
      g.appendChild(p); cell[k] = p;
    }
    parts.push(cell);
  }
  const dp = document.createElementNS(NS, 'circle');
  dp.setAttribute('cx', 6 + (cells - 1) * (W + gap) + 2); dp.setAttribute('cy', 6 + Hh - 4); dp.setAttribute('r', 5.5); dp.setAttribute('fill', C.off);
  g.appendChild(dp);
  return { parts, dp, color: C.seg };
}
function showLcd(lcd, value) {
  // value in points, one decimal: "  11.0" → cells "  11" + "0" with the point lit
  const s = Math.min(999.9, Math.max(0, value)).toFixed(1).replace('.', '').padStart(lcd.parts.length, ' ');
  const chars = s.slice(-lcd.parts.length).split('');
  // blank leading zeros except the one before the point
  for (let i = 0; i < chars.length - 2 && chars[i] === '0'; i++) chars[i] = ' ';
  chars.forEach((ch, i) => { const on = MAP[ch] ?? ''; for (const k of 'abcdefg') lcd.parts[i][k].setAttribute('fill', on.includes(k) ? lcd.color : C.off); });
  lcd.dp.setAttribute('fill', lcd.color);
}

/* ---------- the prover can ---------- */
const GLASS_TOP = 70, GLASS_BOTTOM = 352;
const yOf = (v, max) => GLASS_BOTTOM - (Math.max(0, v) / max) * (GLASS_BOTTOM - GLASS_TOP);
let level = { y: GLASS_BOTTOM, target: GLASS_BOTTOM, slosh: 0, t0: 0 };
function liquidPath(y, amp, phase) {
  let d = `M178 ${y}`;
  for (let x = 178; x <= 222; x += 2) d += ` L${x} ${(y + Math.sin((x - 178) / 44 * Math.PI * 2 + phase) * amp).toFixed(2)}`;
  return { fill: d + ' L222 362 L178 362 Z', top: d };
}
function drawLiquid(now) {
  const k = reduced ? 1 : Math.min(1, (now - level.t0) / 1500);
  const e = 1 - Math.pow(1 - k, 3);
  const y = level.from + (level.target - level.from) * e;
  const amp = reduced ? 0 : 5 * Math.exp(-(now - level.t0) / 900) * (level.target < GLASS_BOTTOM - 2 ? 1 : 0) + (reduced ? 0 : 0.6);
  const p = liquidPath(y, amp, now / 160);
  $('#liquid').setAttribute('d', p.fill);
  $('#liquidTop').setAttribute('d', p.top);
  if (!reduced) requestAnimationFrame(drawLiquid);
}
function setScale(max, ledger, meter, tol, out) {
  const ticks = $('#ticks'); ticks.innerHTML = '';
  const step = niceStep(max / 10);
  for (let v = 0, i = 0; v <= max + 1e-9; v += step, i++) {
    const y = yOf(v, max);
    const l = document.createElementNS(NS, 'path');
    l.setAttribute('d', `M270 ${y}H${i % 2 ? 284 : 292}`); l.setAttribute('stroke', '#0a3332'); l.setAttribute('stroke-width', i % 2 ? 2.5 : 3.5);
    ticks.appendChild(l);
    if (i % 2 === 0) { const t = document.createElementNS(NS, 'text'); t.setAttribute('x', 298); t.setAttribute('y', y + 5); t.textContent = fmtScale(v); ticks.appendChild(t); }
  }
  const band = $('#band');
  const y1 = yOf(ledger + tol, max), y2 = yOf(Math.max(0, ledger - tol), max);
  band.setAttribute('y', y1); band.setAttribute('height', Math.max(3, y2 - y1));
  band.setAttribute('fill', out ? C.bad : C.ok);
  const py = yOf(meter, max);
  $('#pointer').style.transform = `translateY(${py}px)`;
  $('#pointerText').textContent = meter.toFixed(1);
}
const niceStep = (s) => { const p = Math.pow(10, Math.floor(Math.log10(s))); const n = s / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
const fmtScale = (v) => (Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(1));

/* ---------- scenarios: numbers from `checkmeter --demo` ---------- */
const SCENES = {
  off: { meterLabel: 'THEIR METER · CODEX 5-HOUR', meter: 11.0, ledgerLabel: 'YOUR LEDGER · 33K TOKENS LOGGED', ledger: 0.4, max: 14, verdict: 'OFF-LEDGER +10.6', tone: 'bad',
    caption: 'Tue 12:48 → 16:41. The 5-hour meter rose 11 points while this machine logged 33k weighted tokens, worth about 0.4 at this account\u2019s usual rate.' },
  fast: { meterLabel: 'THEIR METER · CODEX WEEK', meter: 17.0, ledgerLabel: 'YOUR LEDGER · 11M TOKENS AT YOUR RATE', ledger: 7.2, max: 20, verdict: 'FAST METER 2.4\u00d7', tone: 'bad',
    caption: 'Sat \u2013 Sun. Same model, same speed tier, and the weekly meter moved 2.4\u00d7 faster than on this account\u2019s normal days.' },
  stuck: { meterLabel: 'THEIR METER · CODEX 5-HOUR', meter: 98, ledgerLabel: 'YOUR LEDGER · WINDOW DUE TO RESET 11:31', ledger: 0, max: 100, verdict: 'STUCK RESET +21 MIN', tone: 'stuck',
    caption: 'The window was due to reset at 11:31. At 11:52 the meter still read 98% with the same reset time, and the client was still refusing work.' },
  clean: { meterLabel: 'THEIR METER · CODEX WEEK', meter: 3.0, ledgerLabel: 'YOUR LEDGER · 4.7M TOKENS AT YOUR RATE', ledger: 3.1, max: 5, verdict: 'ADDS UP \u22120.1', tone: 'ok',
    caption: 'Monday. The meter moved what your own usage says it should. Most windows look like this, and the report says so plainly.' },
};
const lcdMeter = buildLcd($('#lcdMeter')), lcdLedger = buildLcd($('#lcdLedger'));
let run = 0;
function play(sc) {
  const my = ++run;
  const out = sc.tone !== 'ok';
  $('#meterLabel').textContent = sc.meterLabel;
  $('#ledgerLabel').textContent = sc.ledgerLabel;
  $('#meterText').textContent = `vendor meter ${sc.meter} points`;
  $('#ledgerText').textContent = `your ledger ${sc.ledger} points`;
  $('#caption').textContent = sc.caption;
  lcdMeter.color = sc.tone === 'stuck' ? C.stuck : out ? C.bad : C.seg;
  lcdLedger.color = C.seg;
  const v = $('#verdict'); v.className = 'lcd verdict ' + (sc.tone === 'ok' ? '' : sc.tone);
  const vt = $('#verdictText'); vt.textContent = '';
  setScale(sc.max, sc.ledger, sc.meter, Math.max(sc.max * 0.04, sc.ledger * 0.12), out);
  // liquid falls back, then the pour
  level.from = GLASS_BOTTOM; level.target = yOf(sc.ledger, sc.max); level.t0 = performance.now() + (reduced ? 0 : 250);
  if (reduced) { showLcd(lcdMeter, sc.meter); showLcd(lcdLedger, sc.ledger); vt.textContent = sc.verdict; drawLiquid(performance.now() + 5000); return; }
  document.querySelector('.island').classList.add('pouring');
  const t0 = performance.now(), dur = 1500;
  const tick = (now) => {
    if (my !== run) return;
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 2);
    showLcd(lcdMeter, Math.round(sc.meter * e * 10) / 10);
    showLcd(lcdLedger, Math.round(sc.ledger * Math.min(1, e * 1.05) * 10) / 10);
    if (k < 1) requestAnimationFrame(tick);
    else {
      document.querySelector('.island').classList.remove('pouring');
      let i = 0;
      const type = () => { if (my !== run) return; vt.textContent = sc.verdict.slice(0, ++i); if (i < sc.verdict.length) setTimeout(type, 45); };
      setTimeout(type, 200);
    }
  };
  requestAnimationFrame(tick);
}
document.querySelectorAll('.grades button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.grades button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  play(SCENES[b.dataset.s]);
}));
level.from = GLASS_BOTTOM;
if (!reduced) requestAnimationFrame(drawLiquid);
setTimeout(() => play(SCENES.off), reduced ? 0 : 450);

/* ---------- copy ---------- */
document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'copied'; b.classList.add('done'); }
  catch { b.textContent = 'select it'; }
  setTimeout(() => { b.textContent = 'copy'; b.classList.remove('done'); }, 1600);
}));

/* ---------- your own files, analysed in this tab ---------- */
const drop = $('#drop'), input = $('#file');
['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (ev) => handle([...ev.dataTransfer.files]));
drop.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); input.click(); } });
input.addEventListener('change', () => handle([...input.files]));

const LABEL = { OFF_LEDGER: 'OFF-LEDGER', FAST_METER: 'FAST METER', STUCK_RESET: 'STUCK RESET', PLAN_CHANGED: 'PLAN CHANGED', METER_DROP: 'METER DROP', LIMIT_HIT: 'LIMIT HIT', CACHE_TTL: 'CACHE TTL', NO_METER: 'NO METER', NO_BASELINE: 'NO BASELINE' };
async function handle(files) {
  if (!files.length) return;
  const dt = $('#dropText');
  dt.textContent = `READING ${files.length} FILE${files.length > 1 ? 'S' : ''}\u2026`;
  let lib;
  try { lib = await import('./js/analyse.js'); } catch { dt.textContent = 'ANALYSER FAILED TO LOAD'; return; }
  const sources = [];
  let skipped = 0;
  for (const f of files) {
    const text = await f.text();
    const head = text.slice(0, 4000);
    if (/"session_meta"|"token_count"|"rate_limits"/.test(head) || /^rollout-/.test(f.name)) sources.push(lib.parseCodexRollout(text, f.name));
    else if (/"five_hour"|"seven_day"/.test(head)) sources.push(lib.parseClaudeMeterLog(text, f.name));
    else if (/"assistant"|"usage"/.test(head)) sources.push(lib.parseClaudeTranscript(text, f.name));
    else skipped++;
  }
  const src = lib.mergeSources(sources);
  const ts = [...src.events.map((e) => e.t), ...src.readings.map((r) => r.t)];
  const res = $('#result'); res.hidden = false;
  if (!ts.length) { dt.textContent = 'NO USAGE FOUND'; res.innerHTML = `<pre class="term"><code>None of these files had Codex token_count events or Claude Code usage.${skipped ? ` (${skipped} skipped as unrecognised)` : ''}\nCodex keeps them in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl</code></pre>`; return; }
  let since = Infinity, now = 0; for (const t of ts) { if (t < since) since = t; if (t > now) now = t; }
  const rep = lib.analyse(src, { now: now + 1, since: since - 1, version: 'web' });
  const flags = rep.findings.filter((f) => f.severity !== 'note');
  dt.textContent = flags.length ? `${flags.length} READING${flags.length > 1 ? 'S' : ''} DON'T ADD UP` : 'EVERYTHING ADDS UP';
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const lines = [];
  for (const h of rep.harnesses.filter((x) => x.events || x.readings)) lines.push(`<span class="rline head">${h.harness}  ${h.sessions} sessions \u00b7 ${h.events} requests \u00b7 ${lib.fmtTok(h.weighted)} weighted tokens \u00b7 ${h.readings.toLocaleString('en-US')} meter readings</span>`);
  lines.push('');
  if (!rep.findings.length) lines.push('<span class="rline">No findings. The meter moved the way these files say it should.</span>');
  for (const f of rep.findings) {
    const tone = f.kind === 'STUCK_RESET' ? 'stuck' : f.severity === 'flag' ? 'bad' : f.severity === 'review' ? 'warn' : 'dim';
    lines.push(`<span class="rline ${tone}">${f.severity === 'flag' ? '\u2716' : f.severity === 'review' ? '\u25c6' : '\u00b7'} ${esc(LABEL[f.kind] || f.kind)}  ${esc(f.harness)} \u00b7 ${esc(f.title)}</span>`);
    for (const d of f.detail) lines.push(`<span class="rline dim d">${esc(d)}</span>`);
  }
  const top = rep.sessions.slice(0, 8);
  if (top.length) {
    lines.push('', '<span class="rline head">where the meter went · session, 5h pts, week pts, weighted tokens, model, why</span>');
    for (const s of top) lines.push(`<span class="rline">  ${esc(s.id.slice(0, 8))}  ${s.d5h.toFixed(1).padStart(6)} ${s.dWeek.toFixed(1).padStart(6)}  ${lib.fmtTok(s.weighted).padStart(6)}  ${esc((s.model || '?').replace(/^claude-/, ''))}  ${esc(s.causes.slice(0, 2).join(' \u00b7 '))}</span>`);
  }
  if (skipped) lines.push('', `<span class="rline dim">${skipped} file${skipped > 1 ? 's' : ''} skipped: not Codex or Claude Code usage</span>`);
  lines.push('', '<span class="rline dim">Analysed in this tab. For every file on the machine, evidence packs and the guard, run the CLI.</span>');
  res.innerHTML = `<div class="term out">${lines.map((l) => (l === '' ? '<span class="rline gap"></span>' : l)).join('')}</div>`;
  // and let the pump show the headline
  const off = rep.findings.find((f) => f.kind === 'OFF_LEDGER'), fast = rep.findings.find((f) => f.kind === 'FAST_METER');
  if (off && off.expected != null) play({ meterLabel: `YOUR FILE · ${off.harness.toUpperCase()} ${off.window === 'week' ? 'WEEK' : '5-HOUR'}`, meter: off.delta, ledgerLabel: `YOUR LEDGER · ${lib.fmtTok(off.tokens || 0).toUpperCase()} TOKENS LOGGED`, ledger: off.expected, max: Math.max(5, off.delta * 1.25), verdict: `OFF-LEDGER +${(off.delta - off.expected).toFixed(1)}`, tone: 'bad', caption: off.detail[0] });
  else if (fast && fast.ratio) play({ meterLabel: `YOUR FILE · ${fast.harness.toUpperCase()} ${fast.window === 'week' ? 'WEEK' : '5-HOUR'}`, meter: fast.delta, ledgerLabel: 'YOUR LEDGER · AT YOUR USUAL RATE', ledger: fast.delta / fast.ratio, max: Math.max(5, fast.delta * 1.25), verdict: `FAST METER ${fast.ratio.toFixed(1)}\u00d7`, tone: 'bad', caption: fast.title });
  document.querySelectorAll('.grades button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
}
