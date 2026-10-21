# Roadmap

## v0.1 (now)

- Codex: meter readings from `rate_limits` in every rollout, tokens per request, subagent replay de-duplicated.
- Claude Code: tokens and cache TTL from transcripts; the meter recorded from the status line by `checkmeter record`.
- Findings: FAST METER, OFF-LEDGER, STUCK RESET, PLAN CHANGED, METER DROP, CACHE TTL, LIMIT HIT.
- `evidence` (support-ticket markdown), `guard` (PreToolUse hook) and `setup` for both clients, `--demo`, `--json`.
- In-browser analyser on the home page (same code, no upload).

## Next

- **v0.2 pace forecast.** "At this session's rate the 5-hour window runs out at 15:40", in the report and in the recorder's status line.
- **v0.3 more clients.** OpenCode and Gemini CLI, as soon as either writes a vendor meter that can be read locally.
- **v0.4 more than one machine.** `checkmeter export` on each laptop, `checkmeter merge` on one, so OFF-LEDGER can tell "your other machine" from "nobody you know".
- **v0.5 Claude `/usage` import.** Paste or pipe the `/usage` screen to backfill the Claude Code meter for days before `setup claude`.
- npm publish as `checkmeter` so `npx checkmeter` works without the `github:` prefix.

Ideas and votes: [issues](https://github.com/Blackman99/checkmeter/issues).

## Why

Public reports this was built from (all read on 2026-10-21):

- OpenAI's Tibo on 2026-10-20: ~40,000 accounts metered against the wrong plan's limits over the weekend, credits to follow ([recap with quote](https://limitdigest.com/guides/codex-usage-draining-fast-wrong-plan-limits/)).
- [openai/codex#55660](https://github.com/openai/codex/issues/55660): can't prove from local logs whether guardian tokens hit the shared quota.
- [openai/codex#55709](https://github.com/openai/codex/issues/55709): 20 minutes used 15% of a Pro week.
- [openai/codex#55648](https://github.com/openai/codex/issues/55648): a whole Plus 5-hour window in under 4 minutes, measured from session JSONL.
- [openai/codex#55586](https://github.com/openai/codex/issues/55586): "I cannot establish the exact charged amount from the UI".
- [anthropics/claude-code#103673](https://github.com/anthropics/claude-code/issues/103673) and [#103753](https://github.com/anthropics/claude-code/issues/103753): 5-minute cache writes where 1-hour was expected, visible in the transcripts.
- [anthropics/claude-code#103598](https://github.com/anthropics/claude-code/issues/103598): credits spent while the plan bar showed 11%.
