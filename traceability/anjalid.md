# Traceability — anjalid

## Requirement changes

- R1, R2 revised: the denial error carries the matching rule (permission/pattern/action), not the literal
  command text. Narrowed to what the service actually returns.
- R6 revised: no code auto-detects "destructive" commands. Kept the real need (an explicit `rm` rule isn't
  silently overridden by a catch-all) and dropped the "even without a rule" claim.
- R7, R8 kept as written but flagged not-yet-implemented: the storage layer supports what they need
  (`PermissionSaved.remove`, listing saved rules) but no service method exposes it yet.

## Requirements table

| ID | Interview evidence | Requirement | Acceptance criteria | Changed in P4? | Property | Kind | Test | Mutants it kills |
|---|---|---|---|---|---|---|---|---|
| R1 | S-5, O-8 | The denial error's ruleset identifies the rule that caused the denial. | A `DeniedError` thrown for `rm demo.txt` under `{"*":"allow","rm *":"deny"}` has `ruleset` containing `{pattern:"rm *", action:"deny"}`. | Yes | — | — | — | H4 (after strengthening) |
| R2 | S-10, O-8 | The denial exposes the matching rule's pattern. | Same as R1; no dedicated test this round. | Yes | — | — | — | H5 (after strengthening) |
| R3 | C-8, S-10, O-4 | Every command matching the same deny rule gets the same decision. | — | No | evaluate agrees with an independent reference model | model/oracle | `permission.property.test.ts` | H1, H2, H3 |
| R4 | S-7, C-6, O-6 | Removing a rule makes matched commands follow only remaining rules. | — | No | adding a rule and then removing it leaves evaluation unchanged | round-trip | `permission.property.test.ts` | none directly |
| R5 | C-9, C-11, S-12, O-10 | Last matching rule in the config wins, deterministically. | — | No | swapping the order of two conflicting rules flips which one wins | metamorphic | `permission.property.test.ts` | H1, H3 |
| R6 | S-4, C-4, O-4 | An explicit rule for a destructive command overrides a broader catch-all placed before it. | — | Yes (revised) | a specific rm rule overrides a catch-all placed before it | invariant | `permission.property.test.ts` | H3 |
| R7 | S-8, S-9, C-7, O-7 | User can undo "always allow." | — | No (flagged, not implemented) | — | — | — | — |
| R8 | S-9, C-13, C-14 | User can see all current permission rules. | — | No (flagged, not implemented) | — | — | — | — |


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


## Agent failure case

**Mutant:** H4 (R1) survived the original properties, R3 included.

**Why:** R3 only calls evaluate() directly. It never touches ask(), so it has no way to see what DeniedError actually exposes. The bug is in ask()'s filtering logic, completely outside what R3 can reach. The generator and the whole property are scoped to the wrong function.

**Transcript showing this kind of property comes from opencode:** to confirm this style of property is something opencode actually produces and not just something I came up with, I asked it the same kind of question that led to R3, to see if it would independently suggest the same approach.

**Prompt to opencode:** I need a property-based test for the evaluate() function in src/permission/index.ts. Can you write a fast-check property test that checks evaluate against an independent reference implementation, so I can confirm the real function and a simple reference model always agree on commands?


**opencode response:** 
​```diff
+ const commandAlphabet = ["a", "b", "c", " "]
+ const commandArb = fc.array(fc.constantFrom(...commandAlphabet), { maxLength: 8 }).map((chars) => chars.join(""))
+ const commandPatternArb = fc
+   .array(fc.constantFrom(...commandAlphabet, "*", "?"), { maxLength: 8 })
+   .map((chars) => chars.join(""))
+ const permissionPatternArb = fc
+   .array(fc.constantFrom("b", "a", "s", "h", "*", "?"), { maxLength: 6 })
+   .map((chars) => chars.join(""))
+ const generatedRuleArb: fc.Arbitrary<PermissionV1.Rule> = fc.record({
+   permission: permissionPatternArb,
+   pattern: commandPatternArb,
+   action: actionArb,
+ })
+ const generatedRulesetArb = fc.array(generatedRuleArb, { maxLength: 8 })

+ // Independent glob matcher: unlike Wildcard it works over characters directly instead of building a RegExp.
+ function referenceGlob(input: string, pattern: string): boolean {
+   let inputIndex = 0
+   let patternIndex = 0
+   let starIndex = -1
+   let resumeIndex = 0
+
+   while (inputIndex < input.length) {
+     if (patternIndex < pattern.length && (pattern[patternIndex] === "?" || pattern[patternIndex] === input[inputIndex])) {
+       inputIndex += 1
+       patternIndex += 1
+       continue
+     }
+     if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
+       starIndex = patternIndex
+       resumeIndex = inputIndex
+       patternIndex += 1
+       continue
+     }
+     if (starIndex === -1) return false
+     patternIndex = starIndex + 1
+     resumeIndex += 1
+     inputIndex = resumeIndex
+   }
+
+   while (patternIndex < pattern.length && pattern[patternIndex] === "*") patternIndex += 1
+   return patternIndex === pattern.length
+ }
+
+ function referenceMatches(input: string, pattern: string): boolean {
+   // Wildcard treats a trailing " *" as an optional argument suffix.
+   if (pattern.endsWith(" *")) {
+     return referenceGlob(input, pattern.slice(0, -2)) || referenceGlob(input, pattern)
+   }
+   return referenceGlob(input, pattern)
+ }
+
+ function referenceEvaluate(
+   permission: string,
+   command: string,
+   ruleset: PermissionV1.Ruleset,
+ ): PermissionV1.Rule {
+   let result: PermissionV1.Rule | undefined
+   for (const rule of ruleset) {
+     if (referenceMatches(permission, rule.permission) && referenceMatches(command, rule.pattern)) result = rule
+   }
+   return result ?? { permission, pattern: "*", action: "ask" }
+ }

  test("R3: evaluate agrees with an independent reference model", () => {
    fc.assert(
-     fc.property(rulesetArb, patternCommandArb, (ruleset, [, command]) => {
-       const expected = referenceEvaluate(command, ruleset)
+     fc.property(generatedRulesetArb, commandArb, (ruleset, command) => {
+       const expected = referenceEvaluate(PERMISSION, command, ruleset)
        const actual = evaluate(PERMISSION, command, ruleset)
        expect(actual).toEqual(expected)
      }),
    )
  })
​```

I rejected this edit since it would’ve broken R4/R5/R6 since they rely on patternCommandArb, which this removed, but it still confirms opencode independently suggests the same oracle-style property that my actual R3 test uses, just checking evaluate against an independent reference implementation.