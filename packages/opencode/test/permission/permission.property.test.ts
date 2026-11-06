import { test, expect } from "bun:test"
import fc from "fast-check"
import { evaluate } from "../../src/permission/evaluate"

const PERMISSION = "bash"
type Action = "allow" | "ask" | "deny"
type Rule = { permission: string; pattern: string; action: Action }

const actionArb = fc.constantFrom<Action>("allow", "ask", "deny")

const PATTERN_COMMAND_PAIRS: [string, string][] = [
  ["*", "anything -x"],
  ["rm *", "rm file.txt"],
  ["git *", "git status"],
  ["npm *", "npm install"],
  ["ls -la", "ls -la"],
]
const patternCommandArb = fc.constantFrom(...PATTERN_COMMAND_PAIRS)

const ruleArb: fc.Arbitrary<Rule> = fc.record({
  permission: fc.constant(PERMISSION),
  pattern: fc.constantFrom(...PATTERN_COMMAND_PAIRS.map(([p]) => p)),
  action: actionArb,
})
const rulesetArb = fc.array(ruleArb, { maxLength: 6 })

function simpleMatches(command: string, pattern: string): boolean {
  if (pattern === "*") return true
  if (pattern.endsWith(" *")) {
    const prefix = pattern.slice(0, -2)
    return command === prefix || command.startsWith(prefix + " ")
  }
  return command === pattern
}
function referenceEvaluate(command: string, ruleset: Rule[]): Rule {
  let result: Rule | undefined
  for (const rule of ruleset) {
    if (rule.permission === PERMISSION && simpleMatches(command, rule.pattern)) result = rule
  }
  return result ?? { permission: PERMISSION, pattern: "*", action: "ask" }
}

// R3: Every command matching the same deny rule gets the same decision.
// Kind: model/oracle
test("R3: evaluate agrees with an independent reference model", () => {
  fc.assert(
    fc.property(rulesetArb, patternCommandArb, (ruleset, [, command]) => {
      const expected = referenceEvaluate(command, ruleset)
      const actual = evaluate(PERMISSION, command, ruleset as any)
      expect(actual).toEqual(expected)
    }),
  )
})

// R5: When several rules match, the last matching rule in the config wins, the same way every time.
// Kind: metamorphic
test("R5: swapping the order of two conflicting rules flips which one wins", () => {
  fc.assert(
    fc.property(patternCommandArb, actionArb, actionArb, ([pattern, command], actionA, actionB) => {
      fc.pre(actionA !== actionB)
      const ruleA: Rule = { permission: PERMISSION, pattern, action: actionA }
      const ruleB: Rule = { permission: PERMISSION, pattern, action: actionB }
      expect(evaluate(PERMISSION, command, [ruleA, ruleB] as any).action).toBe(actionB)
      expect(evaluate(PERMISSION, command, [ruleB, ruleA] as any).action).toBe(actionA)
    }),
  )
})

// R6 (revised): An explicit rule for a destructive command (e.g. "rm *") overrides a broader catch-all rule placed before it, for every command that rule matches.
// Kind: invariant
test("R6: a specific rm rule overrides a catch-all placed before it", () => {
  fc.assert(
    fc.property(actionArb, actionArb, fc.string({ maxLength: 20 }), (catchAllAction, specificAction, suffix) => {
      fc.pre(catchAllAction !== specificAction)
      const ruleset: Rule[] = [
        { permission: PERMISSION, pattern: "*", action: catchAllAction },
        { permission: PERMISSION, pattern: "rm *", action: specificAction },
      ]
      const command = suffix.length ? `rm ${suffix}` : "rm"
      expect(evaluate(PERMISSION, command, ruleset as any).action).toBe(specificAction)
    }),
  )
})

// R4: Removing a rule makes the commands it matched follow only the remaining rules.
// Kind: round-trip
test("R4: adding a rule and then removing it leaves evaluation unchanged", () => {
  fc.assert(
    fc.property(rulesetArb, ruleArb, patternCommandArb, (baseRules, newRule, [, command]) => {
      const before = evaluate(PERMISSION, command, baseRules as any)
      const withAdded = [...baseRules, newRule]
      const withRemoved = withAdded.slice(0, -1)
      const after = evaluate(PERMISSION, command, withRemoved as any)
      expect(after).toEqual(before)
    }),
  )
})