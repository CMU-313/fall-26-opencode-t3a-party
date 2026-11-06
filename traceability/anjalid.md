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