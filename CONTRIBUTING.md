# Contributing

Thanks for helping check the meter.

## Setup

```sh
git clone https://github.com/Blackman99/checkmeter && cd checkmeter
npm ci            # also builds dist/
npm test          # build + 16 tests (node:test), no network
node dist/cli.js --demo
npm run build:web # the browser bundle for site/ (served with any static server)
```

Node 18.18+. No runtime dependencies, please keep it that way: checkmeter reads people's session files and should be easy to audit.

## Where things live

| path | what |
|---|---|
| `src/core/` | parsers (`codex.ts`, `claude.ts`) and the analysis (`analyse.ts`); no Node APIs, so the same code runs in the browser |
| `src/node/` | file scanning, terminal output, evidence, guard, recorder, setup, demo generator |
| `src/cli.ts` | argument parsing and commands |
| `test/` | `core.test.ts` (parsers, findings on the demo home, guard, recorder, setup) and `cli.test.ts` (end to end) |
| `site/` | landing page and docs (GitHub Pages) |

## Changing a finding

Every finding has to be checkable by hand: it carries the readings it rests on with `file:line`. If you add or tune one, add a case to the demo generator (`src/node/demo.ts`) so `checkmeter --demo` shows it, and assert it in `test/core.test.ts`. A finding that fires on the "steady week" test is a false positive.

## Parsers

Session formats change. If a client update breaks parsing, a fixture line from a real file (meter and usage fields only, no prompts or code) in the test is the most useful thing you can send.

## Wording

Findings say what the numbers show, not what anyone intended. "The meter rose 11 points that no session on this machine explains", not "you were overcharged".
