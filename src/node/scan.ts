import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { parseCodexRollout } from '../core/codex.js';
import { parseClaudeMeterLog, parseClaudeTranscript } from '../core/claude.js';
import type { ParsedSource } from '../core/types.js';
import { mergeSources } from '../core/types.js';

export interface ScanOptions {
  since: number;
  home?: string;
  codexHome?: string[];
  claudeDir?: string[];
  meterLog?: string;
  harness?: 'codex' | 'claude' | 'all';
}

export interface ScanResult {
  source: ParsedSource;
  codexRoots: string[];
  claudeRoots: string[];
  meterLog: string;
  files: { codex: number; claude: number; meter: number; skippedZst: number };
}

export function defaultPaths(home = homedir()) {
  const env = process.env;
  const codex = env.CODEX_HOME ? [env.CODEX_HOME] : [join(home, '.codex')];
  const claude = env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR.split(',').map((s) => s.trim()).filter(Boolean) : [join(home, '.claude'), join(home, '.config', 'claude')];
  const meterLog = join(env.CHECKMETER_HOME || join(home, '.checkmeter'), 'claude-meter.jsonl');
  return { codex, claude, meterLog };
}

function walk(dir: string, out: string[], depth = 0) {
  if (depth > 8) return;
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.isFile() && (e.name.endsWith('.jsonl') || e.name.endsWith('.jsonl.zst'))) out.push(p);
  }
}

const zstd: ((b: Buffer) => Buffer) | undefined = (zlib as any).zstdDecompressSync;

function readText(p: string): string | undefined {
  if (p.endsWith('.zst')) { if (!zstd) return undefined; return zstd(readFileSync(p)).toString('utf8'); }
  return readFileSync(p, 'utf8');
}

export function scan(opts: ScanOptions): ScanResult {
  const def = defaultPaths(opts.home);
  const codexRoots = opts.codexHome ?? (opts.home ? [join(opts.home, '.codex')] : def.codex);
  const claudeRoots = opts.claudeDir ?? (opts.home ? [join(opts.home, '.claude')] : def.claude);
  const meterLog = opts.meterLog ?? (opts.home ? join(opts.home, '.checkmeter', 'claude-meter.jsonl') : def.meterLog);
  const parts: ParsedSource[] = [];
  const files = { codex: 0, claude: 0, meter: 0, skippedZst: 0 };
  const want = opts.harness ?? 'all';
  const fresh = (p: string) => { try { return statSync(p).mtimeMs >= opts.since; } catch { return false; } };
  if (want !== 'claude') {
    for (const root of codexRoots) {
      const list: string[] = [];
      for (const sub of ['sessions', 'archived_sessions']) { const d = join(root, sub); if (existsSync(d)) walk(d, list); }
      // a plain copy wins over a .zst copy of the same rollout
      const plain = new Set(list.filter((p) => p.endsWith('.jsonl')));
      list.sort();
      for (const p of list) {
        if (p.endsWith('.zst') && plain.has(p.slice(0, -4))) continue;
        if (!fresh(p)) continue;
        const text = readText(p);
        if (text == null) { files.skippedZst++; continue; }
        files.codex++;
        parts.push(parseCodexRollout(text, p));
      }
    }
  }
  if (want !== 'codex') {
    for (const root of claudeRoots) {
      const d = join(root, 'projects');
      if (!existsSync(d)) continue;
      const list: string[] = []; walk(d, list); list.sort();
      for (const p of list) {
        if (!p.endsWith('.jsonl') || !fresh(p)) continue;
        files.claude++;
        parts.push(parseClaudeTranscript(readFileSync(p, 'utf8'), p));
      }
    }
    if (existsSync(meterLog)) { files.meter++; parts.push(parseClaudeMeterLog(readFileSync(meterLog, 'utf8'), meterLog)); }
  }
  return { source: mergeSources(parts), codexRoots, claudeRoots, meterLog, files };
}
