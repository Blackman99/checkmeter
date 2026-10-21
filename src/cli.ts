import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyse, DAY } from './core/analyse.js';
import { colorWanted, paint } from './node/color.js';
import { buildDemo } from './node/demo.js';
import { renderEvidence } from './node/evidence.js';
import { guardCheck, latestReadings } from './node/guard.js';
import { record } from './node/record.js';
import { renderReport, tildify } from './node/render.js';
import { defaultPaths, scan } from './node/scan.js';
import { applySetup, guardSnippet, planClaudeSetup } from './node/setup.js';
import { VERSION } from './version.js';

const HELP = `checkmeter ${VERSION} — an independent check meter for your Codex and Claude Code plan

Usage
  checkmeter [report]            what moved your 5h / weekly meters, and which readings don't add up
  checkmeter evidence [-o FILE]  the flagged readings as markdown for a support ticket
  checkmeter setup claude        record the Claude Code meter from the status line (--write to apply)
  checkmeter setup guard claude|codex   print the hook that stops an agent near the limit
  checkmeter guard               the hook itself: exit 2 when a meter is over the line
  checkmeter record              the status-line recorder (Claude Code runs this)
  checkmeter --demo              the full report on a generated demo home

Options
  --days N           look back N days (default 7)
  --since DATE       start at DATE (YYYY-MM-DD), overrides --days
  --harness NAME     codex | claude | all (default all)
  --top N            sessions to list per harness (default 12)
  --json             machine-readable report
  --no-color         plain text (NO_COLOR is honoured too)
  --codex-home DIR   Codex home (default $CODEX_HOME or ~/.codex)
  --claude-dir DIR   Claude Code config dir (default $CLAUDE_CONFIG_DIR or ~/.claude)
  --meter-log FILE   recorded Claude Code meter (default ~/.checkmeter/claude-meter.jsonl)
  --fast-ratio N     how many times your baseline counts as a fast meter (default 2)
  --max-5h N         guard: block at N% of the 5-hour meter (default 90)
  --max-week N       guard: block at N% of the weekly meter (default 95)
  -h, --help · -v, --version

checkmeter only reads files. It never sends anything anywhere.
Docs: https://blackman99.github.io/checkmeter/docs/
`;

const COMMANDS = ['report', 'evidence', 'setup', 'guard', 'record', 'demo', 'help', 'version'];
const FLAGS_WITH_VALUE = ['--days', '--since', '--harness', '--top', '--codex-home', '--claude-dir', '--home', '--max-5h', '--max-week', '--then', '-o', '--out', '--fast-ratio', '--meter-log'];
const BOOL_FLAGS = ['--json', '--no-color', '--color', '--demo', '--write', '--quiet', '-h', '--help', '-v', '--version'];

interface Args { cmd: string; pos: string[]; f: Record<string, string | boolean> }

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const suggest = (x: string, list: string[]) => { const best = list.map((c) => [c, lev(x, c)] as const).sort((a, b) => a[1] - b[1])[0]; return best && best[1] <= 2 ? best[0] : undefined; };

class UsageError extends Error {}

function parse(argv: string[]): Args {
  const f: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a.startsWith('--') && a.includes('=')) { const [k, v] = a.split(/=(.*)/s); f[k] = v; continue; }
    if (FLAGS_WITH_VALUE.includes(a)) {
      const v = argv[++i];
      if (v == null || (v.startsWith('-') && !/^-\d/.test(v))) throw new UsageError(`${a} needs a value`);
      f[a] = v; continue;
    }
    if (BOOL_FLAGS.includes(a)) { f[a] = true; continue; }
    if (a.startsWith('-')) { const s = suggest(a, [...FLAGS_WITH_VALUE, ...BOOL_FLAGS]); throw new UsageError(`unknown option ${a}${s ? `. Did you mean ${s}?` : ''}`); }
    pos.push(a);
  }
  let cmd = 'report';
  if (pos.length) {
    if (COMMANDS.includes(pos[0])) cmd = pos.shift()!;
    else { const s = suggest(pos[0], COMMANDS); throw new UsageError(`unknown command '${pos[0]}'${s ? `. Did you mean \`checkmeter ${s}\`?` : ''} (see checkmeter --help)`); }
  }
  if (f['--demo']) cmd = cmd === 'report' ? 'demo' : cmd;
  return { cmd, pos, f };
}

function numFlag(a: Args, k: string, def: number, min: number, max: number): number {
  const v = a.f[k];
  if (v == null || v === true) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`${k} must be a number from ${min} to ${max} (got '${v}')`);
  return n;
}

function readStdin(): string {
  if (process.stdin.isTTY) return '';
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function main(argv: string[]): number {
  let a: Args;
  try { a = parse(argv); } catch (e) { if (e instanceof UsageError) { process.stderr.write(`checkmeter: ${e.message}\n`); return 64; } throw e; }
  if (a.f['-h'] || a.f['--help'] || a.cmd === 'help') { process.stdout.write(HELP); return 0; }
  if (a.f['-v'] || a.f['--version'] || a.cmd === 'version') { process.stdout.write(`checkmeter ${VERSION}\n`); return 0; }
  try {
    switch (a.cmd) {
      case 'record': return cmdRecord(a);
      case 'guard': return cmdGuard(a);
      case 'setup': return cmdSetup(a);
      default: return cmdReport(a);
    }
  } catch (e) {
    if (e instanceof UsageError) { process.stderr.write(`checkmeter: ${e.message}\n`); return 64; }
    process.stderr.write(`checkmeter: ${(e as Error).message}\n`);
    return 1;
  }
}

function cmdReport(a: Args): number {
  const now = Date.now();
  const days = numFlag(a, '--days', 7, 1, 400);
  let since = now - days * DAY;
  if (typeof a.f['--since'] === 'string') {
    const s = Date.parse(a.f['--since'] + (/^\d{4}-\d{2}-\d{2}$/.test(a.f['--since']) ? 'T00:00:00' : ''));
    if (!Number.isFinite(s)) throw new UsageError(`--since wants a date like 2026-10-14 (got '${a.f['--since']}')`);
    if (s > now) throw new UsageError(`--since ${a.f['--since']} is in the future`);
    since = s;
  }
  const harness = (a.f['--harness'] ?? 'all') as string;
  if (!['codex', 'claude', 'all'].includes(harness)) throw new UsageError(`--harness is codex, claude or all (got '${harness}')`);
  const demo = a.cmd === 'demo' || !!a.f['--demo'];
  let home = typeof a.f['--home'] === 'string' ? a.f['--home'] : undefined;
  if (demo) {
    home = home ?? join(tmpdir(), 'checkmeter-demo');
    buildDemo(home, now);
    since = now - 7 * DAY;
  }
  const res = scan({
    since, home, harness: harness as any,
    codexHome: typeof a.f['--codex-home'] === 'string' ? [a.f['--codex-home']] : undefined,
    claudeDir: typeof a.f['--claude-dir'] === 'string' ? [a.f['--claude-dir']] : undefined,
    meterLog: typeof a.f['--meter-log'] === 'string' ? a.f['--meter-log'] : undefined,
  });
  const report = analyse(res.source, { now, since, version: VERSION, fastRatio: numFlag(a, '--fast-ratio', 2, 1.2, 10), files: { codex: res.files.codex, claude: res.files.claude } });
  const isEvidence = a.cmd === 'evidence';
  if (a.f['--json']) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); return 0; }
  if (isEvidence) {
    const md = renderEvidence(report, { demo });
    const out = (a.f['-o'] ?? a.f['--out']) as string | undefined;
    if (out) {
      writeFileSync(out, md);
      const n = report.findings.filter((f) => f.severity !== 'note').length;
      process.stderr.write(`checkmeter: wrote ${n} finding${n === 1 ? '' : 's'} to ${out}${n ? ' — attach it to your support ticket' : ' (nothing to report)'}\n`);
    } else process.stdout.write(md);
    return 0;
  }
  const empty = !res.files.codex && !res.files.claude && !res.files.meter;
  if (empty) {
    const paths = defaultPaths(home);
    process.stdout.write(`checkmeter ${VERSION} · last ${days} days\n\nNo Codex or Claude Code session files changed in this period.\n  looked in ${(res.codexRoots).map((p) => tildify(p) + '/sessions').join(', ')}\n        and ${res.claudeRoots.map((p) => tildify(p) + '/projects').join(', ')}\n\nUsing a different home? --codex-home DIR / --claude-dir DIR (or $CODEX_HOME / $CLAUDE_CONFIG_DIR).\nWant to see what a report looks like first? checkmeter --demo\n`);
    void paths;
    return 0;
  }
  const P = paint(colorWanted(a.f['--no-color'] ? false : a.f['--color'] ? true : undefined, process.stdout));
  const width = process.stdout.columns || 110;
  process.stdout.write(renderReport(report, { width, top: numFlag(a, '--top', 12, 1, 1000), days: Math.round((now - since) / DAY), paint: P, demo }));
  if (res.files.skippedZst) process.stdout.write(P.dim(`(${res.files.skippedZst} compressed rollout${res.files.skippedZst === 1 ? '' : 's'} skipped: this Node has no zstd; Node 22.15+ reads them)\n`));
  if (res.source.badLines) process.stdout.write(P.dim(`(${res.source.badLines} line${res.source.badLines === 1 ? ' was' : 's were'} not valid JSON and skipped — usually a session that was still being written)\n`));
  return 0;
}

function cmdRecord(a: Args): number {
  const home = typeof a.f['--home'] === 'string' ? a.f['--home'] : homedir();
  const log = typeof a.f['--meter-log'] === 'string' ? a.f['--meter-log'] : defaultPaths(home).meterLog;
  process.stdout.write(record(readStdin(), log, { then: typeof a.f['--then'] === 'string' ? a.f['--then'] : undefined, quiet: !!a.f['--quiet'] }));
  return 0;
}

function cmdGuard(a: Args): number {
  const home = typeof a.f['--home'] === 'string' ? a.f['--home'] : homedir();
  const def = defaultPaths(home);
  const input = readStdin();
  let prefer = a.f['--harness'] as 'codex' | 'claude' | undefined;
  if (!prefer && input) { if (/[\\/]\.claude[\\/]/.test(input)) prefer = 'claude'; else if (/[\\/]\.codex[\\/]/.test(input)) prefer = 'codex'; }
  const latest = latestReadings({ codexHome: typeof a.f['--codex-home'] === 'string' ? a.f['--codex-home'] : def.codex[0], meterLog: def.meterLog, prefer });
  const msg = guardCheck(latest, numFlag(a, '--max-5h', 90, 1, 100), numFlag(a, '--max-week', 95, 1, 100));
  if (msg) { process.stderr.write(msg + '\n'); return 2; }
  return 0;
}

function cmdSetup(a: Args): number {
  const target = a.pos[0];
  const home = typeof a.f['--home'] === 'string' ? a.f['--home'] : homedir();
  if (target === 'guard') {
    const t = a.pos[1];
    if (!t) throw new UsageError('which agent? `checkmeter setup guard claude` or `checkmeter setup guard codex`');
    if (t !== 'claude' && t !== 'codex') { const s = suggest(t, ['claude', 'codex']); throw new UsageError(`unknown guard target '${t}'${s ? `. Did you mean \`checkmeter setup guard ${s}\`?` : '; use `checkmeter setup guard claude` or `checkmeter setup guard codex`'}`); }
    process.stdout.write(guardSnippet(t, numFlag(a, '--max-5h', 90, 1, 100), numFlag(a, '--max-week', 95, 1, 100)));
    return 0;
  }
  if (target !== 'claude') throw new UsageError(target ? `nothing to set up for '${target}'. Codex already writes its meter readings; try \`checkmeter setup claude\` or \`checkmeter setup guard codex\`` : 'what to set up? `checkmeter setup claude` or `checkmeter setup guard claude|codex`');
  const plan = planClaudeSetup(home);
  if (plan.already) { process.stdout.write(`Already set up: ${tildify(plan.path)} runs \`checkmeter record\` in the status line.\n`); return 0; }
  const show = JSON.stringify({ statusLine: plan.after.statusLine }, null, 2);
  if (!a.f['--write']) {
    process.stdout.write(`To record the Claude Code meter, ${tildify(plan.path)} needs:\n\n${show}\n\n${plan.note.map((n) => '  · ' + n + '\n').join('')}  · needs checkmeter on PATH (npm i -g checkmeter); npx is too slow for a status line\n\nApply it: checkmeter setup claude --write   (a backup of the file is kept)\n`);
    return 0;
  }
  const backup = applySetup(plan);
  process.stdout.write(`Updated ${tildify(plan.path)}${backup ? ` (backup: ${tildify(backup)})` : ''}.\nClaude Code reloads it by itself; readings start with the next reply and land in ${tildify(defaultPaths(home).meterLog)}.\n`);
  if (!existsSync(join(home, '.claude'))) process.stdout.write('Note: no ~/.claude folder yet; is Claude Code installed on this machine?\n');
  return 0;
}

process.exitCode = main(process.argv.slice(2));
