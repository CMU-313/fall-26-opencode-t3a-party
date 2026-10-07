# User Guide

## Unfamiliar-File Edit Warnings (PR #18)

When you use OpenCode as a student, it's seamless and convenient to rubber-stamp AI changes
that aren't really understood, especially edits that go under the table to files you've
never opened. This warning feature detects which files are actually familiar to you,
which are not, and prompt you whenever AI changes one of the unfamiliar files.

### How it works

A file counts as *familiar* once you've read it, edited it yourself, or
@-mentioned it. Sessions also seed familiarity from git history, so files you've
already authored or have uncommitted work in don't get flagged.

When the AI tries to edit, write, or patch a file you *haven't* touched,
OpenCode stops and asks — **even if your permission rules would normally let it
through**. The prompt lists the unfamiliar files and nudges you to read the diff.
You can:

- **Allow once** — apply just this edit.
- **Always allow AI edits on unfamiliar files** — stop the forced prompts for the
  rest of the session. You'll still get a one-line notice under each edit so you
  know an unfamiliar file changed.
- **Reject** — decline, optionally telling the AI what to do instead.

Brand-new files the AI creates get a lighter "AI created a new file you haven't
reviewed" notice rather than a blocking prompt — the whole file is already in the
diff you're about to read.

The feature is on by default; there's nothing to configure.

### Trying it out

In a git repo, start a session and:

1. Get the AI to edit a file you haven't opened → you should see the **Unfamiliar files** 
warning, even with permissive rules.
2. Read that file yourself, then ask for another edit → no warning this time.
3. Pick "Always allow…" on a fresh file → later unfamiliar edits apply silently
   but leave the one-line notice.
4. Ask the AI to create a new file → you get the new-file notice, not a prompt.
5. Restart in a repo you've committed to → your own files edit without warnings.

### Tests

Tests sit next to the code they cover:

- `packages/opencode/test/familiarity/familiarity.test.ts` — the core logic:
  files are unfamiliar until marked, path variants (`abs`/`rel`/`./`) resolve to
  one file, nonexistent (new) files are never unfamiliar, and projects stay
  isolated from each other.
- `packages/opencode/test/permission/next.test.ts` — the policy: unfamiliar edits
  force a prompt past allowing rules, "always" opts into silent auto-allow, and
  deny rules still win.
- `packages/opencode/test/tool/{edit,write,apply_patch}.test.ts` — each tool
  attaches the unfamiliar/new-file metadata the rest of the feature relies on.
- `packages/tui/test/cli/tui/permission-unfamiliar.test.tsx` — the prompt renders
  the warning and the opt-out option.

Run them with `bun test` in the relevant package (e.g.
`cd packages/opencode && bun test test/familiarity test/permission test/tool`).

They cover every layer the change touches — what's unfamiliar, whether to prompt,
the metadata connecting the two, and what you see — plus the edge cases (new
files, path aliasing, concurrent sessions, cross-project leakage) most likely to
regress, which is why I'm confident they're enough.

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
