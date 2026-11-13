# Traceability — anjalid

## Requirement changes

- R1, R2 revised: the denial error carries the matching rule (permission/pattern/action), not the literal
  command text. Narrowed to what the service actually returns.
- R6 revised: no code auto-detects "destructive" commands. Kept the real need (an explicit `rm` rule isn't
  silently overridden by a catch-all) and dropped the "even without a rule" claim.
- R7, R8 kept as written but flagged not-yet-implemented: the storage layer supports what they need
  (`PermissionSaved.remove`, listing saved rules) but no service method exposes it yet.

## Requirements table

| ID | Interview evidence | Requirement | Acceptance criteria | Changed in P4? | Property | Kind | Test |
|---|---|---|---|---|---|---|---|
| R1 | S-5, O-8 | The denial error's ruleset identifies the rule that caused the denial. | A `DeniedError` thrown for `rm demo.txt` under `{"*":"allow","rm *":"deny"}` has `ruleset` containing `{pattern:"rm *", action:"deny"}`. | Yes | — | — | — |
| R2 | S-10, O-8 | The denial exposes the matching rule's pattern. | Same as R1; no dedicated test this round. | Yes | — | — | — |
| R3 | C-8, S-10, O-4 | Every command matching the same deny rule gets the same decision. | — | No | evaluate agrees with an independent reference model | model/oracle | `permission.property.test.ts` |
| R4 | S-7, C-6, O-6 | Removing a rule makes matched commands follow only remaining rules. | — | No | adding a rule and then removing it leaves evaluation unchanged | round-trip | `permission.property.test.ts` |
| R5 | C-9, C-11, S-12, O-10 | Last matching rule in the config wins, deterministically. | — | No | swapping the order of two conflicting rules flips which one wins | metamorphic | `permission.property.test.ts` |
| R6 | S-4, C-4, O-4 | An explicit rule for a destructive command overrides a broader catch-all placed before it. | — | Yes (revised) | a specific rm rule overrides a catch-all placed before it | invariant | `permission.property.test.ts` |
| R7 | S-8, S-9, C-7, O-7 | User can undo "always allow." | — | No (flagged, not implemented) | — | — | — |
| R8 | S-9, C-13, C-14 | User can see all current permission rules. | — | No (flagged, not implemented) | — | — | — |


## AI assistance
Claude read the real permission source files and 
wrote the test setup, which includes the arbitraries (actionArb, ruleArb, rulesetArb, patternCommandArb), the pattern/command pairings (PATTERN_COMMAND_PAIRS), and the R3 property in full, including the independent reference model (simpleMatches, referenceEvaluate). I wrote the R4, R5, and R6 property bodies myself, using that setup. I reviewed all of it against the real evaluate() implementation and confirmed the four properties pass and tie back to the requirements they cite.

## Hand-written mutants

| ID | Requirement targeted | Change | Predicted killer | Actual result |
|---|---|---|---|---|
| H1 | R5 | `evaluate()`: `findLast` → `find`, so the first matching rule wins instead of the last | R5 | Killed by R3, R5, and R6 |
| H2 | R3 | `evaluate()`: default fallback action `"ask"` → `"allow"` when no rule matches | R3 | Killed by R3 |
| H3 | R6 | `evaluate()`: swapped operands in the match condition (`permission`/`pattern` crossed) | R6 | Killed by R3, R5, and R6 |
| H4 | R1 | `ask()`: dropped the `.filter()` on the denial ruleset, so `DeniedError` exposes the full unfiltered ruleset | None (no test covers R1 this round) | Survived |
| H5 | R2 | `ask()`: filter compares `request.permission` against `rule.pattern` instead of `rule.permission` | None (no test covers R2 this round) | Survived |


### Strengthening

H4 and H5 (R1, R2) survived because nothing was actually testing what `DeniedError` shows.

Fix: I pulled the filtering logic out into its own function, `filterDeniedRuleset`, and wrote a new test for R1/R2 that checks every rule in a denial error actually matches the permission being denied. The old tests never varied `permission` at all.

I reapplied both H4 and H5's changes and confirmed the new test catches them both.

**Final mutation score:** no equivalent mutants, both were real bugs. Stryker scoped run: 9/9 killed, 100%. Including H4 and H5 now fixed: 11/11, 100%.


## Stryker comparison

**Mutation score:** 9 mutants generated, 9 killed, 0 survived. 100% (seed 42)

**Which of your hand-written mutants did Stryker never generate? Why not?**
H4 and H5 didn’t show up because they’re in ask(), not evaluate(), and I only told Stryker to look at evaluate(). Stryker can’t make mutants in code you don’t point it at.

**Which Stryker survivors would you never have thought of? Are any of them bugs a real developer might plausibly write?**
None, this run had zero survivors.

**What does each approach find that the other doesn’t?**
Stryker just tries every small change it can think of inside the lines I gave it, so it caught everything in evaluate() without me having to come up with those cases myself. But it can’t find bugs outside that range or bugs that only matter because of what a requirement actually says, that’s where H4 and H5 come in, since they’re about what DeniedError shows, not about evaluate()’s logic.

