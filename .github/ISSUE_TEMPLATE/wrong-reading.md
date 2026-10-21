---
name: A finding looks wrong
about: checkmeter flagged something that adds up, or missed something that doesn't
labels: wrong-reading
---

**The finding** (paste the block from the report, or say what it missed)

```
```

**The readings it points to** (meter values only, no prompts):

```sh
# for each file:line in the finding
sed -n 'LINEp' FILE | jq -c '{timestamp, rate_limits: .payload.rate_limits}'
```

**What actually happened in that span** (other machine, cloud task, plan change, nothing…)

**checkmeter version / client version:** `checkmeter --version` · Codex `codex --version` or Claude Code `claude --version`
