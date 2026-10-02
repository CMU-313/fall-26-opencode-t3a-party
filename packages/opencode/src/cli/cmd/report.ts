import { Effect } from "effect"
import { EditDecision } from "@opencode-ai/core/permission/decision"
import { SessionV2 } from "@opencode-ai/core/session"
import { effectCmd } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { UI } from "../ui"

export const ReportCommand = effectCmd({
  command: "report",
  describe: "show how many agent-proposed edits were accepted or rejected in this project",
  builder: (yargs) =>
    yargs.option("session", {
      describe: "only report on this session ID",
      type: "string",
    }),
  handler: Effect.fn("Cli.report")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const decisions = yield* EditDecision.Service
    const summary = yield* decisions.summary({
      projectID: ctx.project.id,
      sessionID: args.session ? SessionV2.ID.make(args.session) : undefined,
    })
    if (summary.proposed === 0) {
      UI.println(
        args.session
          ? `No accept/reject decisions recorded for session ${args.session} yet.`
          : "No accept/reject decisions recorded for this project yet.",
      )
      return
    }
    displayReport(summary)
  }),
})

export function displayReport(summary: EditDecision.Summary) {
  const width = 56
  const row = (label: string, value: string) =>
    `│${label}${" ".repeat(Math.max(0, width - label.length - value.length))}${value}│`
  console.log("┌" + "─".repeat(width) + "┐")
  console.log("│" + "AI EDIT REVIEW".padStart(35).padEnd(width) + "│")
  console.log("├" + "─".repeat(width) + "┤")
  console.log(row("Sessions", summary.sessions.toLocaleString()))
  console.log(row("Edits Proposed", summary.proposed.toLocaleString()))
  console.log(row("Accepted", summary.accepted.toLocaleString()))
  console.log(row("Rejected", summary.rejected.toLocaleString()))
  console.log(row("Accept Ratio", `${(summary.acceptRatio * 100).toFixed(1)}%`))
  console.log("└" + "─".repeat(width) + "┘")
}
