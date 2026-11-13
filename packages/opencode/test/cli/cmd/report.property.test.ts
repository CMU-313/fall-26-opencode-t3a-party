import { describe, expect, spyOn, test } from "bun:test"
import fc from "fast-check"
import { displayReport } from "../../../src/cli/cmd/report"

// Property tests for the `opencode report` table (displayReport). Requirement IDs match traceability/anishjai.md.
// The core properties check EditDecision.summary(); this file checks what the student actually sees.

fc.configureGlobal({ seed: 42 })

const NUM_RUNS = 200

// Reads the printed table back into { label: value } by splitting each "│label   value│" row.
function render(summary: Parameters<typeof displayReport>[0]) {
  const lines: string[] = []
  const log = spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
  try {
    displayReport(summary)
  } finally {
    log.mockRestore()
  }
  const rows: Record<string, string> = {}
  for (const line of lines) {
    const match = /^│(\S.*?)\s{2,}(\S+)│$/.exec(line) ?? /^│(\S.*?)\s(\S+)│$/.exec(line)
    if (match) rows[match[1]] = match[2]
  }
  return rows
}

// Expected "Accept Ratio" text computed from the counts with integer math (round half up to one
// decimal), so it doesn't reuse the `acceptRatio * 100` expression the table itself uses.
function expectedRatio(accepted: number, proposed: number) {
  const tenths = Math.floor((2000 * accepted + proposed) / (2 * proposed))
  return `${Math.floor(tenths / 10)}.${tenths % 10}%`
}

describe("report table properties", () => {
  // R1: Accepted + Rejected = Edits Proposed, ratio between 0% and 100%, shown to one decimal
  // (acceptance criterion: 4 accepts / 2 rejects shows "66.7%").
  // Kind: model / oracle. The table's rows must match the counts it was given.
  test("R1: the table shows the counts and the accept ratio to one decimal", () => {
    fc.assert(
      fc.property(
        fc.nat(60),
        fc.nat(60),
        fc.integer({ min: 1, max: 5 }),
        (accepted, rejected, sessions) => {
          fc.pre(accepted + rejected > 0)
          const proposed = accepted + rejected
          const rows = render({ sessions, proposed, accepted, rejected, acceptRatio: accepted / proposed })

          expect(rows["Sessions"]).toBe(String(sessions))
          expect(rows["Edits Proposed"]).toBe(String(proposed))
          expect(rows["Accepted"]).toBe(String(accepted))
          expect(rows["Rejected"]).toBe(String(rejected))
          expect(rows["Accept Ratio"]).toBe(expectedRatio(accepted, proposed))
        },
      ),
      { numRuns: NUM_RUNS },
    )
    console.log(`R1 (table): passed ${NUM_RUNS} random runs`)
  })
})
