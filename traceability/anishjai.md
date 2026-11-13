# Traceability: Anish Jain (anishjai)

**Target feature:** `opencode report`, which totals every accept/reject decision a student made on agent-proposed edits across a project (or one session) and prints a summary table. Main source files:
- CLI command: [packages/opencode/src/cli/cmd/report.ts](../packages/opencode/src/cli/cmd/report.ts)
- Aggregation (`summary()`): [packages/core/src/permission/decision.ts](../packages/core/src/permission/decision.ts)
- Decision table: [packages/core/src/permission/decision.sql.ts](../packages/core/src/permission/decision.sql.ts)
- Where decisions get recorded: [packages/opencode/src/permission/index.ts](../packages/opencode/src/permission/index.ts)

## Requirements

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test | Mutants it kills |
|---|---|---|---|---|---|---|---|
| R1 | C-6, O-6, O-7, S-5: "The accept ratio shouldn't ever be over 100%" | Accepted + Rejected = Edits Proposed. Accept Ratio is always between 0% and 100%. | With 4 accepts and 2 rejects, report shows Proposed 6, Accepted 4, Rejected 2, Ratio 66.7%. Never shows NaN or a negative number. | No | accepted + rejected = proposed, ratio is finite and in [0, 1], and counts match what was recorded (invariant) | [report.property.test.ts](../packages/core/test/report/report.property.test.ts): "R1: accepted + rejected = proposed and the ratio stays in [0, 1]"; [report.property.test.ts (table)](../packages/opencode/test/cli/cmd/report.property.test.ts): "R1: the table shows the counts and the accept ratio to one decimal" | H1, H2; red team A3 (table property, after fix) |
| R2 | C-9, O-9, O-10: "It should be locked to just the project folder you're in" | The report only counts decisions from sessions in the current project. | Project A has 3 recorded decisions and Project B has 5. Running `opencode report` in A shows Edits Proposed 3. | No | adding decisions to another project leaves this project's report unchanged (metamorphic) | [report.property.test.ts](../packages/core/test/report/report.property.test.ts): "R2: decisions in another project never change this project's report" | H2 |
| R3 | C-15, O-15, S-13: "add up the parts and see if they equal the total" | The per-session reports for every session in a project add up to the plain report. | Session X has 3 accepted / 1 rejected, Y has 1 accepted / 1 rejected. `--session X` shows 4/3/1, `--session Y` shows 2/1/1, and the overall report shows 2 sessions, 6 proposed, 4 accepted, 2 rejected. | No | summing every `--session` report equals the plain report (model / oracle) | [report.property.test.ts](../packages/core/test/report/report.property.test.ts): "R3: per-session reports add up to the plain report" | H2; H3 and red team A1 (after strengthening) |
| R4 | C-11, O-11, O-13, O-14: "It should just go back to what it was before you did those 3 edits" | New decisions show up in the report right away, and deleting a session removes its decisions. | Report starts at 2 sessions, 6 proposed, 4 accepted, 2 rejected. Accepting 3 edits in a new session gives 3 sessions, 9 proposed, 7 accepted, 2 rejected, 77.8%. Deleting that session brings it back to 2 / 6 / 4 / 2 / 66.7%. | No | adding a session raises the report by exactly its decisions, deleting it restores the original report (round-trip) | [report.property.test.ts](../packages/core/test/report/report.property.test.ts): "R4: adding then deleting a session puts the report back where it was" | H4; red team A1 |
| R5 | C-14: "Don't just show zeros, because then I'd think I didn't do anything in that session." | A session ID that doesn't exist or belongs to another project gives an error, not a table of zeros. | `opencode report --session abc123`, where abc123 is not in this project, prints "Session not found in this project: abc123" and exits with a non-zero code. | No | a typo'd id or a session from another project always gives SessionNotFoundError (invariant) | [report.property.test.ts](../packages/core/test/report/report.property.test.ts): "R5: a session id not in this project is an error, never zeros"; [report-cli.property.test.ts](../packages/opencode/test/cli/cmd/report-cli.property.test.ts): "R5: report --session with an unknown id fails instead of printing zeros" | H5; red team A2 (command property, after fix) |
| R6 | C-17, C-18, C-20, C-21, O-17: "that should probably have its own counter so it doesn't skew the numbers", "maybe show both? Like 1 decision, 5 edits" | Any edit that goes through without the student answering a prompt (allowed by a config rule, or by an earlier "always" reply) counts in its own Auto-Approved row and never changes Proposed, Accepted, Rejected, or the ratio. Edits that still show a prompt, including forced unfamiliar-file prompts, count as normal decisions. | With 4 accepted and 2 rejected, plus 3 edits allowed by `"edit": "allow"`, report shows Proposed 6, Accepted 4, Rejected 2, Ratio 66.7%, Auto-Approved 3. One "always" reply that also lets 2 pending edits through then adds 1 to Accepted and 2 to Auto-Approved. | Yes | Not tested yet (not built) | | None (not built) |
| R7 | C-26, O-21: "an option to export as JSON or CSV" | `opencode report --json` prints one JSON object to stdout with the same counts as the table, and `acceptRatio` as the unrounded accepted / proposed (0 to 1). A project with no decisions prints all zeros instead of a message. | Using the R1 project, `opencode report --json` output parses as JSON and equals `{"sessions":2,"proposed":6,"accepted":4,"rejected":2,"acceptRatio":0.6666666666666666}`. | Yes | Not tested yet (not built) | | None (not built) |

"Sessions" in every report means sessions with at least one recorded decision (the query counts distinct sessions in the decision table). This is on purpose: a session where the agent never proposed an edit has nothing to review. R3's property now checks this directly against the generator (see Hand-written mutants, H3), which also answers Emre's review note.

Properties written or suggested by opencode or another AI tool: Claude Code helped me write the actual code behind the 5 properties and generators, though the ideation and reflections were mine.

## Requirement changes

| ID | Original requirement (P3) | Revised requirement | Why it changed |
|---|---|---|---|
| R6 | Edits auto-approved by config count in their own Auto-Approved row and stay out of Proposed and the ratio. | Any edit that goes through without the student answering a prompt (allowed by a config rule, or by an earlier "always" reply) counts in its own Auto-Approved row and never changes Proposed, Accepted, Rejected, or the ratio. Edits that still show a prompt, including forced unfamiliar-file prompts, count as normal decisions. | Conflict and checkability. "Auto-approved by config" isn't the same as "never prompted": our team's unfamiliar-file warning (#8) still forces a prompt on a config-allowed edit, so the original wording conflicts with that feature. It also didn't say what happens when one "always" reply lets several edits through, which interviewees split on (C-20 counts each edit, C-21 wants "1 decision, 5 edits"). The revision keeps what C-17, C-18, and O-17 asked for (unreviewed edits get their own counter and don't skew the ratio) and covers both cases. |
| R7 | `opencode report --json` prints the same numbers in a JSON file. | `opencode report --json` prints one JSON object to stdout with the same counts as the table, and `acceptRatio` as the unrounded accepted / proposed (0 to 1). A project with no decisions prints all zeros instead of a message. | Checkability. "Prints ... in a JSON file" says two different things, and "the same numbers" doesn't say whether the ratio is the table's rounded 66.7% or the 0.667 in the example, so a test couldn't tell right from wrong. Printing a text message for an empty project would also break the scripts O-21 wanted to plug this into. The revision keeps the export ask from C-26 and O-21 (JSON is the format both mentioned). |

## Hand-written mutants

Each patch is in [mutants/anishjai/](../mutants/anishjai/) and applies to `packages/core/src/permission/decision.ts` with `git apply`. Predictions were written before running any mutant. Tests run with fast-check seed 42.

| ID | Requirement targeted | Change | Predicted killer | Actual result |
|---|---|---|---|---|
| H1 | R1 | `decision.ts`: ratio guard changed to `rejected === 0 ? 1 : accepted / proposed`, so an empty project (and any all-accept session) shows 100% | R1's exact-ratio assertion (empty project must be 0) | Killed by R1 (exact-ratio check on an empty project). Matched prediction. |
| H2 | R2 | `decision.ts`: project filter only applied when `--session` is given, so the plain report counts every project's decisions | R2 (and likely R1/R3, since all runs share one database) | Killed by R1, R2, R3. Matched prediction. |
| H3 | R3 | `decision.ts`: query starts from `SessionTable` with a left join, so Sessions counts sessions with no decisions | Survives: per-session and total reports both count the empty sessions, so they still add up | Survived, as predicted: R3 only compared per-session reports with the total, and both counted the empty sessions the same way. Killed after strengthening R3 to check Sessions against the generator (counterexample `[[[]]]`: one session with no decisions, expected 0, received 1). |
| H4 | R4 | `decision.ts`: `summary()` caches results per project/session, so new decisions don't show up until restart | R4 only (the only property that asks for the same report twice after a change in this project) | Killed by R4 only. Matched prediction. |
| H5 | R5 | `decision.ts`: session existence check drops the project condition, so a session from another project returns zeros | R5 (other-project branch of the generator) | Killed by R5. Matched prediction. |

## Stryker comparison

- **Config:** [packages/core/stryker.anishjai.config.json](../packages/core/stryker.anishjai.config.json). Command runner running only `bun test test/report/report.property.test.ts`, mutating only `summary()` (`src/permission/decision.ts:99-137`), `coverageAnalysis: off`, `concurrency: 1` (the properties share one database), and `inPlace: true` (the tests import `@opencode-ai/core/...`, which resolves to the real source folder, so mutants written to Stryker's sandbox copy would never be exercised).
- **How to run:** from `packages/core`, `../opencode/node_modules/.bin/stryker run stryker.anishjai.config.json` (Stryker is installed in `packages/opencode` by #28).
- **fast-check seed:** 42 (`fc.configureGlobal({ seed: 42 })` at the top of both property files).
- **Report:** [mutants/anishjai/mutation.html](../mutants/anishjai/mutation.html) (final run).

| Run | Mutants | Killed | Survived | Timeout / no coverage | Raw score | Excluding equivalent (4) |
|---|---|---|---|---|---|---|
| Initial (P4 properties + seed) | 25 | 21 | 4 | 0 / 0 | 84.00% | 21 / 21 = 100% |
| Final (after strengthening) | 25 | 21 | 4 | 0 / 0 | 84.00% | 21 / 21 = 100% |

Strengthening R3 didn't change the Stryker score, because none of Stryker's 25 mutants made the change H3 makes (see question 1). All four survivors are equivalent:

| Survivor | Change | Why it's equivalent |
|---|---|---|
| S1 | `decision.ts:99` `Effect.fn("EditDecision.summary")` → `Effect.fn("")` | The string is only the name of the tracing span. It's never returned, stored, or printed by `summary()` or `opencode report`, so no caller can tell the difference. |
| S2 | `decision.ts:127` `row?.accepted` → `row.accepted` | The query is an aggregate (`countDistinct`/`sum`) with no `GROUP BY`, so SQLite always returns exactly one row, even when no decisions match. `row` is never undefined, so the optional chain never does anything. |
| S3 | `decision.ts:128` `row?.rejected` → `row.rejected` | Same as S2: the aggregate query always returns one row, so `row` is always defined. |
| S4 | `decision.ts:131` `row?.sessions` → `row.sessions` | Same as S2. |

**1. Which of your hand-written mutants did Stryker never generate? Why not?**
None of H1–H5 appeared exactly. H2, H3, H4 and H5 are structural changes that Stryker's operators don't make: H2 and H5 drop one argument from a drizzle `and(...)` call, H3 swaps the table the query starts from and the join type, and H4 adds new code (a cache). Stryker only rewrites single expressions in place, like operators, literals, and conditions. H1 is the closest: Stryker made `proposed !== 0` and forced the ternary to `true`/`false`, but never the "guard on the wrong variable" bug (`rejected === 0 ? 1 : ...`), because that needs a different identifier and a different constant.

**2. Which Stryker survivors would you never have thought of? Are any of them bugs a real developer might plausibly write?**
I'd never have thought of S1, emptying the span name, or of the optional-chaining removals S2–S4. All four turned out to be equivalent, so none of them is a bug a user could hit. S2–S4 are the kind of change a developer might make on purpose ("row can't be null here"), and it's only safe because of how SQLite handles aggregate queries with no `GROUP BY`.

**3. What does each approach find that the other doesn't?**
Hand-written mutants found the one real hole in my properties: H3 showed that R3's "parts add up to the total" oracle can't see a mistake both sides make the same way. Stryker found nothing like that, because its local edits break the numbers badly enough that every property notices. In return, Stryker checked every expression mechanically, including the `coalesce` SQL fragments, the ternary, and `accepted * proposed`, and showed they're all covered. It also flagged the equivalent `row?.` code, which I wouldn't have checked by hand. Hand-written mutants test whether the properties capture the requirement. Stryker tests whether they cover every line.

## Red team

Feature claimed by **Vlad Miloserdov (vmiloser, Team Zero)**, who posted three mutants against `da4b152` [on PR #25](https://github.com/CMU-313/fall-26-opencode-t3a-party/pull/25#issuecomment-6779753120). Each patch was applied from his comment exactly as posted, with seed 42.

| Mutant | Sent by | Requirement | Change | Result before | Fix | Result after |
|---|---|---|---|---|---|---|
| A1 | Vlad Miloserdov (vmiloser) | R3 | `decision.ts`: `countDistinct(session_id)` → `count(session_id)`, so Sessions counts decision rows | Killed by R4 (`during.sessions` must be `before.sessions + 1`, but a new session with several decisions adds several) | None needed. The strengthened R3 (Sessions vs. the generator) also kills it now. | Killed by R3, R4 |
| A2 | Vlad Miloserdov (vmiloser) | R5 | `report.ts`: CLI catches `SessionNotFoundError` and returns a zero summary instead of failing | Survived: every property called `EditDecision.summary()` directly, which still returns the error | New property [packages/opencode/test/cli/cmd/report-cli.property.test.ts](../packages/opencode/test/cli/cmd/report-cli.property.test.ts) "R5: report --session with an unknown id fails instead of printing zeros". It runs the real `ReportCommand` handler (full instance bootstrap) with generated never-created session ids and asserts it rejects with a `CliError` whose message is `Session not found in this project: <id>`, and that it never prints the zero-decision message. | Killed: counterexample `["A"]` (session `ses_missing_A`), the handler resolved instead of failing with `CliError` |
| A3 | Vlad Miloserdov (vmiloser) | R1 | `report.ts`: Accept Ratio printed with `toFixed(0)` instead of `toFixed(1)` | Survived: no property looked at the printed table | New property [packages/opencode/test/cli/cmd/report.property.test.ts](../packages/opencode/test/cli/cmd/report.property.test.ts) "R1: the table shows the counts and the accept ratio to one decimal". It renders `displayReport` for generated counts, parses each row, and checks it against counts and a ratio computed with integer math, not from `acceptRatio * 100`. | Killed: counterexample `[0,1,1]` (0 accepted, 1 rejected, 1 session), the table showed `0%` instead of `0.0%` |

## Agent failure case

**Where opencode wrote it.** I asked opencode (`opencode run -m anthropic/claude-sonnet-5`, build agent) to write a fast-check property for R3 on commit `0c96b2a`, before I strengthened R3. The full prompt, tool calls, response, and test output are in [mutants/anishjai/opencode-transcript.md](../mutants/anishjai/opencode-transcript.md). I didn't create a `/share` link, because it uploads the session publicly. A first run in my working copy just read the R3 property I had already strengthened and copied it back, so I reran it on the earlier commit.

> **Prompt:** Write a fast-check property test for this requirement of the `opencode report` feature (`EditDecision.summary` in `packages/core/src/permission/decision.ts`): R3, "The per-session reports for every session in a project add up to the plain report." Follow the style of `packages/core/test/report/report.property.test.ts`. Print the test code in your reply and do not edit any files.

The property it wrote (the core of its response):

```ts
            fc.asyncProperty(sessions, async (mine) => {
              const { project, prefix } = fresh()
              await run(addProject(project))
              const ids = await run(addSessions(project, prefix, mine))

              const total = await run(service.summary({ projectID: project }))
              const parts = await Promise.all(
                ids.map((sessionID) => run(service.summary({ projectID: project, sessionID }))),
              )
              const sum = (key: "sessions" | "proposed" | "accepted" | "rejected") =>
                parts.reduce((n, part) => n + part[key], 0)

              expect(total.sessions).toBe(sum("sessions"))
              expect(total.proposed).toBe(sum("proposed"))
              expect(total.accepted).toBe(sum("accepted"))
              expect(total.rejected).toBe(sum("rejected"))
            }),
```

opencode added: *"this version just isolates it with only the generators and `tools` helpers ... R3 actually needs."*

**Mutant it let survive: H3** (`summary()` starts from `SessionTable` with a left join, so Sessions counts sessions that have no decisions).

```
$ bun test test/report/opencode-r3.tmp.test.ts   # opencode's property + seed 42, H3 applied
R3: passed 100 random runs
 1 pass
 0 fail
```

**Why the property was too weak.** It's an always-passing oracle for this kind of bug: it checks `summary()` against `summary()`. The total and each `--session` report come from the same query, so any mistake that query makes for every session, like counting empty sessions, shows up on both sides of the equation and cancels out. The generator does make empty sessions (`maxLength: 6` with no minimum), so this is an assertion problem, not a generator problem. Nothing compares Sessions with an independent count of what was recorded. opencode also mostly restated the R3 property already in the file, which is why it inherited the same blind spot.

**Strengthened version.** Two assertions that check against the generator instead of the implementation (now in [report.property.test.ts](../packages/core/test/report/report.property.test.ts), R3):

```ts
              expect(total.sessions).toBe(mine.filter((list) => list.length > 0).length)
              parts.forEach((part, i) => expect(part.sessions).toBe(mine[i].length > 0 ? 1 : 0))
```

**Evidence it kills H3** (same seed, H3 applied):

```
{ seed: 42, path: "2:3", endOnFailure: true }
Counterexample: [[[]]]
Expected: 0
Received: 1
{ seed: 42, path: "2:3", endOnFailure: true }
Counterexample: [[[]]]
Expected: 0
Received: 1
(fail) report properties > R3: per-session reports add up to the plain report [27.25ms]
 0 pass
 1 fail
```

Without the mutant, both versions pass 100 runs.

## Triage

All five properties (R1 to R5) passed the first time I ran them, so no code or property fixes were needed. To make sure they weren't passing trivially, I broke `summary()` a few ways locally and checked they fail: removing the project filter fails R1, R2, R3; dropping the empty-project guard (NaN ratio) fails R1; removing the session existence check fails R5.

