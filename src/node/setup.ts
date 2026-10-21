import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function claudeSettingsPath(home: string): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.split(',')[0]?.trim() || join(home, '.claude');
  return join(dir, 'settings.json');
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface SetupPlan { path: string; before: any; after: any; already: boolean; note: string[] }

export function planClaudeSetup(home: string, recordCmd = 'checkmeter record'): SetupPlan {
  const path = claudeSettingsPath(home);
  let before: any = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    try { before = raw.trim() ? JSON.parse(raw) : {}; } catch { throw new Error(`${path} is not valid JSON; fix it first (checkmeter will not rewrite a file it cannot read)`); }
  }
  const after = JSON.parse(JSON.stringify(before));
  const note: string[] = [];
  const cur = before.statusLine;
  if (cur && typeof cur.command === 'string' && cur.command.includes('checkmeter record')) return { path, before, after, already: true, note: ['the status line already runs `checkmeter record`'] };
  if (cur && cur.type === 'command' && typeof cur.command === 'string') {
    after.statusLine = { ...cur, command: `${recordCmd} --then ${sq(cur.command)}` };
    note.push('your current status line keeps running; checkmeter appends its meter after it');
  } else {
    after.statusLine = { type: 'command', command: recordCmd };
  }
  return { path, before, after, already: false, note };
}

export function applySetup(plan: SetupPlan, now = Date.now()): string | undefined {
  mkdirSync(dirname(plan.path), { recursive: true });
  let backup: string | undefined;
  if (existsSync(plan.path)) { backup = `${plan.path}.checkmeter-backup-${new Date(now).toISOString().replace(/[:.]/g, '-')}`; copyFileSync(plan.path, backup); }
  writeFileSync(plan.path, JSON.stringify(plan.after, null, 2) + '\n');
  return backup;
}

export function guardSnippet(target: string, max5h: number, maxWeek: number): string {
  const cmd = `checkmeter guard --max-5h ${max5h} --max-week ${maxWeek}`;
  if (target === 'claude' || target === 'claude-code') return `# Claude Code: add to ~/.claude/settings.json (merge into an existing "hooks" block).
# Exit code 2 blocks the tool call and shows checkmeter's message to Claude.
# The guard reads the meter that \`checkmeter record\` saves, so run \`checkmeter setup claude\` first.
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "${cmd} --harness claude", "timeout": 10 }]
      }
    ]
  }
}
`;
  if (target === 'codex') return `# Codex: add to ~/.codex/config.toml.
# Exit code 2 with a reason on stderr blocks the tool call (codex-rs/hooks/src/events/pre_tool_use.rs).
# The guard reads the newest rollout's own rate_limits reading; nothing else to set up.
[features]
hooks = true

[[hooks.PreToolUse]]

[[hooks.PreToolUse.hooks]]
type = "command"
command = "${cmd} --harness codex"
statusMessage = "checking the usage meter"
`;
  throw new Error(`unknown guard target '${target}'; use \`checkmeter setup guard claude\` or \`checkmeter setup guard codex\``);
}
