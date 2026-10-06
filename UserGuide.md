# User Guide

## Edit Decision Tracking (Issue [#9](https://github.com/CMU-313/fall-26-opencode-t3a-party/issues/9))

### What it does 
When the agent proposes a file edit, opencode records whether you accepted or rejected it. Every accept ("once" or "always") or reject you make through a permission prompt writes one row to the local `edit_decision` table, tagged with the session, the user, the edit's permission ID and a timestamp.


### How to use it
1. Start opencode (bun dev) and have the agent propose a file edit.
2. Accept or reject the edit prompt as you normally would.
3. After accepting an edit, the query shows a new row with decision = accepted. After rejecting one, it shows rejected.


### How to verify

2 ways:

- Query the database directly by running:

```
sqlite3 ~/.local/share/opencode/opencode-local.db "select session_id, user_id, edit_id, decision, time_created from edit_decision order by time_created desc limit 10;"
```

- Run the demo script, which simulates one accept and reject and prints the rows written to `edit_decision` for that session

```
cd packages/core
bun run demo-edit-decision.ts
```

### Tests
Tests live in
[`packages/core/test/permission.test.ts`](packages/core/test/permission.test.ts),
in the `EditDecision tracking` describe block. They cover:

- an accepted decision is recorded on `reply: "once"`
- an accepted decision is recorded on `reply: "always"`
- a rejected decision is recorded on `reply: "reject"`
- non-`edit` permissions (e.g. `read`) are never recorded
- a request that's interrupted/never replied to is never recorded
- two concurrent writes for the same edit ID don't create duplicate rows

This is sufficient coverage because it tests every branch of `reply()` that can produce or skip a decision, and it accounts for the concurrency case.