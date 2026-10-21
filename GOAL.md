# Goal

**Be an independent check meter for your AI coding plan:** from the session files already on your machine, show what moved your 5-hour and weekly usage meters, and flag every reading that doesn't add up.

At a fuel pump, the pump's own display is the seller's meter. A weights & measures inspector doesn't argue with it; they pour into a calibrated can and compare. checkmeter is that can. Codex and Claude Code both log the vendor's meter and the tokens behind it; nobody puts the two side by side.

## What "done" looks like for a user

1. `npx github:Blackman99/checkmeter` on a laptop with a week of Codex or Claude Code use prints, first, the readings that don't add up (or says plainly that everything does), then where the meter went by session.
2. Every finding points at the `file:line` of the readings it rests on, so it can be checked by hand in a minute.
3. `checkmeter evidence -o meter-evidence.md` turns that into something you can send to support without editing.
4. The guard stops an agent at a line you pick, before the wall.

## Non-goals

- No network calls, accounts, dashboards or telemetry. It reads files.
- Not a cost tracker. Token totals are a means here; [ccusage](https://github.com/ryoppippi/ccusage) and friends do totals well.
- Not an accusation engine. A finding is "this doesn't match your own history", stated with its numbers.

## Where this came from

On 2026-10-20 (17:10 UTC) Tibo (@thsottiaux), who works on Codex at OpenAI, posted that about 40,000 accounts had usage applied against limits that "did not correspond to their actual selected plan" over the weekend, and that credits would be added ([recap with the full quote](https://limitdigest.com/guides/codex-usage-draining-fast-wrong-plan-limits/)). The same week, people in [openai/codex#55660](https://github.com/openai/codex/issues/55660), [#55709](https://github.com/openai/codex/issues/55709) and [anthropics/claude-code#103673](https://github.com/anthropics/claude-code/issues/103673) were asking how to prove from their own logs what used their limit. The meter readings were on their disks the whole time. More links in [ROADMAP.md](ROADMAP.md#why).
