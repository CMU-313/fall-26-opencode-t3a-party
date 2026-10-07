import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EditDecision } from "@opencode-ai/core/permission/decision"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EditDecision.node])))

const project = Project.ID.make("prj_report")
const other = Project.ID.make("prj_other")

function seed(sessions: Record<string, { project: Project.ID; decisions: EditDecision.Decision[] }>) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decisions = yield* EditDecision.Service
    for (const id of [project, other]) {
      yield* db
        .insert(ProjectTable)
        .values({ id, worktree: AbsolutePath.make(`/${id}`), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }
    for (const [id, session] of Object.entries(sessions)) {
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionV2.ID.make(id),
          project_id: session.project,
          slug: id,
          directory: `/${session.project}`,
          title: id,
          version: "test",
          agent: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.forEach(session.decisions, (decision, index) =>
        decisions.record({
          sessionID: SessionV2.ID.make(id),
          userID: "student",
          editID: `${id}_edit_${index}`,
          decision,
        }),
      )
    }
  })
}

describe("EditDecision.summary", () => {
  it.effect("aggregates decisions across every session in the project", () =>
    Effect.gen(function* () {
      yield* seed({
        ses_a: { project, decisions: ["accepted", "accepted", "rejected"] },
        ses_b: { project, decisions: ["accepted", "rejected", "rejected", "accepted", "accepted"] },
        ses_c: { project: other, decisions: ["rejected", "rejected"] },
      })

      const decisions = yield* EditDecision.Service
      expect(yield* decisions.summary({ projectID: project })).toEqual({
        sessions: 2,
        proposed: 8,
        accepted: 5,
        rejected: 3,
        acceptRatio: 5 / 8,
      })
    }),
  )

  it.effect("scopes the summary to a single session", () =>
    Effect.gen(function* () {
      yield* seed({
        ses_a: { project, decisions: ["accepted", "accepted", "rejected"] },
        ses_b: { project, decisions: ["rejected"] },
      })

      const decisions = yield* EditDecision.Service
      expect(yield* decisions.summary({ projectID: project, sessionID: SessionV2.ID.make("ses_a") })).toEqual({
        sessions: 1,
        proposed: 3,
        accepted: 2,
        rejected: 1,
        acceptRatio: 2 / 3,
      })
    }),
  )

  it.effect("treats a session from another project as not found", () =>
    Effect.gen(function* () {
      yield* seed({ ses_c: { project: other, decisions: ["accepted"] } })

      const decisions = yield* EditDecision.Service
      const error = yield* decisions
        .summary({ projectID: project, sessionID: SessionV2.ID.make("ses_c") })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(EditDecision.SessionNotFoundError)
      expect(error.sessionID).toBe(SessionV2.ID.make("ses_c"))
    }),
  )

  it.effect("fails with a clear error for a session ID that does not exist", () =>
    Effect.gen(function* () {
      yield* seed({ ses_a: { project, decisions: ["accepted"] } })

      const decisions = yield* EditDecision.Service
      const error = yield* decisions
        .summary({ projectID: project, sessionID: SessionV2.ID.make("ses_typo") })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(EditDecision.SessionNotFoundError)
    }),
  )

  it.effect("returns zeros instead of NaN when there is no data", () =>
    Effect.gen(function* () {
      yield* seed({ ses_a: { project, decisions: [] } })

      const decisions = yield* EditDecision.Service
      expect(yield* decisions.summary({ projectID: project })).toEqual({
        sessions: 0,
        proposed: 0,
        accepted: 0,
        rejected: 0,
        acceptRatio: 0,
      })
    }),
  )
})
