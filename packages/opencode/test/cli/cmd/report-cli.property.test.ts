import { afterAll, describe, expect, spyOn, test } from "bun:test"
import fc from "fast-check"
import { ReportCommand } from "../../../src/cli/cmd/report"
import { CliError } from "../../../src/cli/effect-cmd"
import { disposeAllInstances } from "../../fixture/fixture"

// Property test for the `opencode report --session <id>` command (R5). Requirement IDs match traceability/anishjai.md.
// The core R5 property checks EditDecision.summary(); this one runs the real command handler, so it also catches
// the CLI swallowing SessionNotFoundError and printing a zero report (red team A2).

fc.configureGlobal({ seed: 42 })

// every run boots a project instance, so keep the run count low
const NUM_RUNS = 10

afterAll(async () => {
  await disposeAllInstances()
})

describe("report command properties", () => {
  // R5: A session ID that doesn't exist gives an error, not a table of zeros.
  // Kind: invariant. For any session id that was never created, the command fails with a CliError
  // naming that id and prints nothing.
  test(
    "R5: report --session with an unknown id fails instead of printing zeros",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.stringMatching(/^[A-Za-z0-9]{1,12}$/), async (typo) => {
          const session = `ses_missing_${typo}`
          const printed: string[] = []
          const log = spyOn(console, "log").mockImplementation((line: string) => void printed.push(line))
          const out = spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
            printed.push(String(chunk))
            return true
          })
          const result = await Promise.resolve(
            ReportCommand.handler({ session, _: [], $0: "opencode" } as never),
          ).then(
            () => undefined,
            (error: unknown) => error,
          )
          log.mockRestore()
          out.mockRestore()

          expect(result).toBeInstanceOf(CliError)
          expect((result as CliError).message).toBe(`Session not found in this project: ${session}`)
          expect(printed.join("")).not.toContain("No accept/reject decisions")
        }),
        { numRuns: NUM_RUNS },
      )
      console.log(`R5 (command): passed ${NUM_RUNS} random runs`)
    },
    60_000,
  )
})
