First release.

- `checkmeter` reads `~/.codex/sessions` and `~/.claude/projects` and reports which 5-hour / weekly meter readings don't add up: FAST METER, OFF-LEDGER, STUCK RESET, PLAN CHANGED, METER DROP, CACHE TTL, LIMIT HIT.
- `checkmeter evidence -o meter-evidence.md`: the flagged readings with `file:line` and a `sed | jq` per reading, for a support ticket.
- `checkmeter setup claude`: records the Claude Code meter from the status line, keeping your existing status line.
- `checkmeter guard` + `checkmeter setup guard claude|codex`: a PreToolUse hook that stops the agent near the line.
- `checkmeter --demo`: the whole thing on generated data.

Install: `npx github:Blackman99/checkmeter`, or `npm install -g` the tarball below. Node 18.18+, no runtime dependencies.
