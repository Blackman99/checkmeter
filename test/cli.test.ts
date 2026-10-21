import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('dist/cli.js');
const run = (args: string[], env: Record<string, string> = {}, input?: string) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env }, input });

test('--demo prints the verdicts first', () => {
  const r = run(['--demo', '--home', mkdtempSync(join(tmpdir(), 'cm-cli-'))]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DEMO DATA/);
  assert.match(r.stdout, /READINGS THAT DON'T ADD UP/);
  assert.match(r.stdout, /OFF-LEDGER/);
  assert.match(r.stdout, /FAST METER/);
  assert.match(r.stdout, /WHERE THE METER WENT/);
  assert.ok(r.stdout.indexOf('READINGS') < r.stdout.indexOf('WHERE THE METER WENT'));
});

test('--json is valid JSON', () => {
  const r = run(['--demo', '--json', '--home', mkdtempSync(join(tmpdir(), 'cm-cli-'))]);
  const j = JSON.parse(r.stdout);
  assert.equal(j.tool, 'checkmeter');
  assert.ok(j.findings.length >= 6);
});

test('empty home explains where it looked', () => {
  const home = mkdtempSync(join(tmpdir(), 'cm-empty-'));
  const r = run(['--home', home], { CODEX_HOME: '', CLAUDE_CONFIG_DIR: '' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No Codex or Claude Code session files changed/);
  assert.match(r.stdout, /checkmeter --demo/);
});

test('usage errors exit 64 with a suggestion', () => {
  let r = run(['evidnce']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /Did you mean `checkmeter evidence`\?/);
  r = run(['--dayz', '3']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /Did you mean --days\?/);
  r = run(['--days', 'abc']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /--days must be a number/);
  r = run(['setup', 'guard', 'codx']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /Did you mean `checkmeter setup guard codex`\?/);
  r = run(['--days']);
  assert.match(r.stderr, /--days needs a value/);
});

test('guard exits 2 with the reason on stderr', () => {
  const home = mkdtempSync(join(tmpdir(), 'cm-guard-'));
  const now = Date.now();
  const line = JSON.stringify({ t: now - 30_000, session: 's', five_hour: { used_percentage: 96, resets_at: Math.round(now / 1000) + 3600 }, seven_day: { used_percentage: 50, resets_at: Math.round(now / 1000) + 86400 } });
  mkdirSync(join(home, '.checkmeter'));
  writeFileSync(join(home, '.checkmeter', 'claude-meter.jsonl'), line + '\n');
  const r = run(['guard', '--home', home, '--harness', 'claude'], { CHECKMETER_HOME: '' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /Claude Code 5-hour meter is at 96%/);
  const ok = run(['guard', '--home', home, '--harness', 'claude', '--max-5h', '99'], { CHECKMETER_HOME: '' });
  assert.equal(ok.status, 0);
});

test('help and version', () => {
  assert.match(run(['--help']).stdout, /independent check meter/);
  assert.match(run(['-v']).stdout, /^checkmeter \d+\.\d+\.\d+/);
});
