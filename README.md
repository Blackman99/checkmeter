<p align="center"><img src="site/img/logo-512.png" alt="checkmeter logo: a stainless prover can with a mint level line and one coral overshoot tick" width="128"></p>

<h1 align="center">checkmeter</h1>

<p align="center"><b>An independent check meter for your AI coding plan.</b><br>
From the session files Codex and Claude Code already write on your machine: what moved your 5-hour and weekly usage meters, and every reading that doesn't add up.</p>

<p align="center"><a href="https://blackman99.github.io/checkmeter/">Home</a> · <a href="https://blackman99.github.io/checkmeter/docs/">Docs</a> · <a href="https://github.com/Blackman99/checkmeter/releases">Releases</a></p>

---

## The problem

Your plan has a meter: a 5-hour bar and a weekly bar. When it empties faster than it should, the usage page shows a percentage and nothing else. On 2026-10-20 an OpenAI Codex lead said about 40,000 accounts had been metered against the wrong plan's limits over a weekend ([recap with the quote](https://limitdigest.com/guides/codex-usage-draining-fast-wrong-plan-limits/)); issue trackers are full of people asking how to prove what used their limit ([openai/codex#55660](https://github.com/openai/codex/issues/55660), [#55709](https://github.com/openai/codex/issues/55709), [anthropics/claude-code#103673](https://github.com/anthropics/claude-code/issues/103673)).

The readings are already on your disk. Codex writes the vendor's meter into every `token_count` event:

```sh
grep -rho '"used_percent":[0-9.]*' ~/.codex/sessions | tail
```

checkmeter puts those readings next to the tokens the same files logged, and tells you which ones don't fit your own history.

## Install

```sh
npx github:Blackman99/checkmeter          # Node 18.18+, no runtime dependencies
```

or `npm install -g` the tarball from the [latest release](https://github.com/Blackman99/checkmeter/releases/latest). It reads files and prints a report. It never sends anything anywhere.

## Use

```sh
checkmeter                 # last 7 days, Codex + Claude Code
checkmeter --demo          # the same report on a generated week, if you want to see every finding first
```

![checkmeter --demo in a terminal: the findings (CACHE TTL, FAST METER, STUCK RESET, OFF-LEDGER, PLAN CHANGED, METER DROP, LIMIT HIT), a PACE line per open window with the Claude 5-hour window running out before its reset, then the sessions that moved the meter](site/img/demo.gif)

<sub>The GIF is `checkmeter --demo`: generated data, not a real account.</sub>

What it can say: **FAST METER** (the meter moved ≥2× your own baseline for the same model and speed tier) · **OFF-LEDGER** (points no session on this machine explains) · **STUCK RESET** (the reset time passed, the window didn't) · **PLAN CHANGED** (`plan_type` in the readings switched, or switched and came back) · **METER DROP** (went down without a reset) · **CACHE TTL** (Claude Code stopped writing the 1-hour cache) · or, most of the time, that it all adds up.

Under the findings, **PACE** says where each open window is heading at your current rate: on pace for 44% at the reset, or runs out ≈ 11:37, 1 h 40 min before it. With the recorder on, the status line adds `· out 11:37` only when the 5-hour window is set to run dry early.

Then:

```sh
checkmeter evidence -o meter-evidence.md   # the flagged readings, file:line and a sed|jq per reading, for support
checkmeter setup claude --write            # record the Claude Code meter from the status line (keeps yours)
checkmeter setup guard codex               # a PreToolUse hook that stops the agent at 90% of the 5-hour window
```

Every command and flag, the configuration, and how the numbers are computed: **[docs](https://blackman99.github.io/checkmeter/docs/)**.

## Honest limits

It only sees this machine. Codex logs whole percents (±0.5 pts per reading), so findings need several points before they fire. Claude Code readings exist from the day you run `setup claude`. A finding means a reading doesn't match your own history; it's not proof of a billing error.

## More

[GOAL.md](GOAL.md) · [ROADMAP.md](ROADMAP.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · MIT licensed · not affiliated with OpenAI or Anthropic.
