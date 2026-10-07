# User Guide

## `/explain` command and code provenance (issues [#10](https://github.com/CMU-313/fall-26-opencode-t3a-party/issues/10) and [#21](https://github.com/CMU-313/fall-26-opencode-t3a-party/issues/21))

**`/explain` (#10)** explains a file or symbol in the context of the whole project. The answer has three sections: "What this does", "Where it is used", and "Why it is structured this way". Only searches through the project, not third parties or dependencies like `node_modules`.

**Code provenance (#21)** adds git history when you give a line range. opencode passes the commits to the model, which cites them in the "Why" section. Commit messages are treated as untrusted data.

### How to use

#### Setup

First, ensure Bun is installed on your device, then install dependencies with `bun install`.

When using opencode locally, a model provider must be configured with an API key. If you don't have one already, you can get a free one from OpenRouter. Configure it by running `bun dev auth login`, selecting your provider, and pasting in your API key.

#### Run

Start opencode with:

```bash
bun dev
```

Select your model with `Ctrl+x m`. Type `/` to see the list of commands, and select `/explain`.

The format is `/explain path/to/file:(line range)` (e.g`/explain packages/opencode/src/git/provenance.ts:180-200`).

- Without a line range (e.g `/explain path/to/file`), git history is not included.
- You can name a function instead of, or along with, a file (e.g `/explain path/to/file someFunction`).
- Without any input (e.g `/explain`), the model asks you what you want explained.

### Automated tests
The automated tests for each issue are located in:

i10 (/explain)

- `packages/opencode/test/command/command.test.ts` (Whole file)
- `packages/core/test/plugin/command.test.ts` Lines 21, 45-60
- `packages/opencode/test/session/prompt.test.ts` Lines 1710-1732 

i21 (code provenance)

- `packages/opencode/test/git/provenance.test.ts` (Whole file)
- `packages/opencode/test/git/provenance-git-output.test.ts` (Whole file)
- `packages/opencode/test/command/explain-provenance.test.ts` (Whole file)
- `packages/opencode/test/session/prompt.test.ts` Lines 1821-1947

Each test file checks:
- **`test/command/command.test.ts`** and **`packages/core/test/plugin/command.test.ts`**: `/explain` is registered correctly, its template contains every required rule, a config entry can override it, and the two template copies stay identical.
- **`test/command/explain-provenance.test.ts`**: the template tells the model to cite only the history it is given and to treat commit subjects as untrusted.
- **`test/git/provenance.test.ts`**: history lookup against temporary git repos. Covers the right commits in the right order, uncommitted code, non-git projects, invalid ranges, paths outside the project, symlinks, renames, and unusual filenames.
- **`test/git/provenance-git-output.test.ts`**: how git's output and errors are handled, using fake git output.
- **`test/session/prompt.test.ts`** (tests with "explain" in the name): end to end through the prompt pipeline. The model receives the template with the user's target, history is added only for `/explain` with a line range, a bad range doesn't break the command, and `@file` or shell syntax inside a commit message is never run.

**Why these are sufficient.** 

The output depends on the model, so the exact output can't be tested. 
 Instead, the tests prove everything that we can control and check: the command is registered, the model receives the right instructions with the user's target, and the git history it receives is correct. 

 The provenance tests also cover about 99% of the lines in `src/git/provenance.ts`, and every error case and security rule (i.e. paths outside the project, untrusted commit messages, no changes to the repo) also have their own tests.
 
  Finally, we can check whether the model follows instructions correctly by manually running and testing it.
  
  
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
