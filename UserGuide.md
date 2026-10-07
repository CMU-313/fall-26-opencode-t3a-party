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

## Usage Report (Issue [#13](https://github.com/CMU-313/fall-26-opencode-t3a-party/issues/13))

### What it does
`opencode report` adds up the accept/reject decisions from Edit Decision Tracking (#9) across every session in the current project and prints the totals: sessions, edits proposed, accepted, rejected, and the accept ratio. It's for an instructor who wants the numbers for a whole project without opening sessions one at a time.

### How to use it
Run it from inside a project directory:

```
opencode report
```

```
┌────────────────────────────────────────────────────────┐
│                     AI EDIT REVIEW                     │
├────────────────────────────────────────────────────────┤
│Sessions                                               2│
│Edits Proposed                                         6│
│Accepted                                               4│
│Rejected                                               2│
│Accept Ratio                                       66.7%│
└────────────────────────────────────────────────────────┘
```

To look at one session only:

```
opencode report --session <session id>
```

If nothing is recorded yet you get `No accept/reject decisions recorded for this project yet.` instead of an empty table. If the session id doesn't exist in this project you get `Session not found in this project: <id>` and a non zero exit code.

From a checkout of the repo the command is `bun run --cwd packages/opencode --conditions=browser src/index.ts report`.

### How to verify
1. Start opencode in a project and accept or reject a few agent edits (see Edit Decision Tracking above for how those get saved).
2. Run `opencode report`. The counts should match what you just did.
3. Run it with `--session` and the session id from step 1. Sessions should be 1.
4. Run it with a made up session id. You should get the not found error.

### Tests
[`packages/core/test/edit-decision.test.ts`](packages/core/test/edit-decision.test.ts). Run with `cd packages/core && bun test test/edit-decision.test.ts`. The tests insert sample sessions and decisions across two projects and check:

- totals across every session in the project (and the other project's rows stay out)
- `--session` scoping to one session
- a session from another project is treated as not found
- a session id that doesn't exist is treated as not found
- a project with no decisions gives zeros, not NaN

I think that's enough because the feature is one query, and these five cover each part of it: the join, the project filter, the optional session filter, the not found check, and the empty case. The CLI on top is a thin wrapper, so I checked it by hand against a seeded database (full report, one session, bad id, empty project), and the help text is covered by the CLI snapshot test.
