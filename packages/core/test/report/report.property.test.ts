import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import fc from "fast-check"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EditDecision } from "@opencode-ai/core/permission/decision"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "../lib/effect"

// Property tests for `opencode report` (EditDecision.summary). Requirement IDs match traceability/anishjai.md.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EditDecision.node])))

// each property does a few hundred db writes, so give it more than the 5s default
const TIMEOUT = 60_000
const NUM_RUNS = 100

// CI runs `bun test --only-failures`, which hides passing test names, so print one line per property
// to show in the CI log that it ran.
const ran = (name: string) => console.log(`${name}: passed ${NUM_RUNS} random runs`)

type Decision = EditDecision.Decision

// Generators.
// One session's decisions. Mixes fully random lists (lots of empty sessions, which is where a
// divide-by-zero would show up) with all-accept and all-reject sessions (the 100% / 0% edges
// interviewees brought up).
const decisions = fc.oneof(
  fc.array(fc.constantFrom<Decision>("accepted", "rejected"), { maxLength: 6 }),
  fc.array(fc.constant<Decision>("accepted"), { minLength: 1, maxLength: 6 }),
  fc.array(fc.constant<Decision>("rejected"), { minLength: 1, maxLength: 6 }),
)
// A session with at least one decision, built directly instead of filtering.
const nonEmpty = fc.array(fc.constantFrom<Decision>("accepted", "rejected"), { minLength: 1, maxLength: 6 })
// A project's sessions. 0 sessions is allowed so the "nothing recorded yet" case comes up.
const sessions = fc.array(decisions, { maxLength: 5 })
const someSessions = fc.array(nonEmpty, { minLength: 1, maxLength: 5 })

// Every fast-check run gets its own project ids, since all the runs share one database.
let runs = 0
function fresh() {
  runs++
  return {
    project: Project.ID.make(`prj_mine_${runs}`),
    other: Project.ID.make(`prj_other_${runs}`),
    prefix: `ses_${runs}`,
  }
}

function count(list: Decision[][], decision: Decision) {
  return list.flat().filter((d) => d === decision).length
}

// db helpers for seeding projects, sessions, and decisions
const tools = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const service = yield* EditDecision.Service
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

  const addProject = (id: Project.ID) =>
    db
      .insert(ProjectTable)
      .values({ id, worktree: AbsolutePath.make(`/${id}`), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)

  // makes one session in `project`, records its decisions, and returns the session id
  const addSession = (project: Project.ID, id: string, list: Decision[]) =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make(id)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: project,
          slug: id,
          directory: `/${project}`,
          title: id,
          version: "test",
          agent: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.forEach(list, (decision, i) =>
        service.record({ sessionID, userID: "student", editID: `${id}_edit_${i}`, decision }),
      )
      return sessionID
    })

  const addSessions = (project: Project.ID, prefix: string, all: Decision[][]) =>
    Effect.forEach(all, (list, i) => addSession(project, `${prefix}_${i}`, list))

  const deleteSession = (id: SessionV2.ID) =>
    db.delete(SessionTable).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)

  return { service, run, addProject, addSession, addSessions, deleteSession }
})

describe("report properties", () => {
  // R1: Accepted + Rejected = Edits Proposed. Accept Ratio is always between 0% and 100%.
  // Kind: invariant
  it.effect(
    "R1: accepted + rejected = proposed and the ratio stays in [0, 1]",
    () =>
      Effect.gen(function* () {
        const { service, run, addProject, addSessions } = yield* tools
        yield* Effect.promise(() =>
          fc.assert(
            fc.asyncProperty(sessions, async (mine) => {
              const { project, prefix } = fresh()
              await run(addProject(project))
              await run(addSessions(project, prefix, mine))
              const s = await run(service.summary({ projectID: project }))

              expect(s.accepted).toBe(count(mine, "accepted"))
              expect(s.rejected).toBe(count(mine, "rejected"))
              expect(s.accepted + s.rejected).toBe(s.proposed)
              expect(Number.isFinite(s.acceptRatio)).toBe(true)
              expect(s.acceptRatio).toBeGreaterThanOrEqual(0)
              expect(s.acceptRatio).toBeLessThanOrEqual(1)
              expect(s.acceptRatio).toBe(s.proposed === 0 ? 0 : s.accepted / s.proposed)
            }),
            { numRuns: NUM_RUNS },
          ),
        )
        ran("R1")
      }),
    TIMEOUT,
  )

  // R2: The report only counts decisions from sessions in the current project.
  // Kind: metamorphic. Adding decisions to a different project must not change this project's report.
  it.effect(
    "R2: decisions in another project never change this project's report",
    () =>
      Effect.gen(function* () {
        const { service, run, addProject, addSessions } = yield* tools
        yield* Effect.promise(() =>
          fc.assert(
            fc.asyncProperty(sessions, someSessions, async (mine, theirs) => {
              const { project, other, prefix } = fresh()
              await run(addProject(project))
              await run(addProject(other))
              await run(addSessions(project, `${prefix}_mine`, mine))
              const before = await run(service.summary({ projectID: project }))

              await run(addSessions(other, `${prefix}_theirs`, theirs))
              const after = await run(service.summary({ projectID: project }))
              expect(after).toEqual(before)
            }),
            { numRuns: NUM_RUNS },
          ),
        )
        ran("R2")
      }),
    TIMEOUT,
  )

  // R3: The per-session reports for every session in a project add up to the plain report.
  // Kind: model / oracle. The oracle is adding up the `--session` results by hand.
  it.effect(
    "R3: per-session reports add up to the plain report",
    () =>
      Effect.gen(function* () {
        const { service, run, addProject, addSessions } = yield* tools
        yield* Effect.promise(() =>
          fc.assert(
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
            { numRuns: NUM_RUNS },
          ),
        )
        ran("R3")
      }),
    TIMEOUT,
  )

  // R4: New decisions show up in the report right away, and deleting a session removes its decisions.
  // Kind: round-trip. Adding a session raises the report by exactly its decisions, deleting it goes back to the start.
  it.effect(
    "R4: adding then deleting a session puts the report back where it was",
    () =>
      Effect.gen(function* () {
        const { service, run, addProject, addSession, addSessions, deleteSession } = yield* tools
        yield* Effect.promise(() =>
          fc.assert(
            fc.asyncProperty(sessions, nonEmpty, async (mine, added) => {
              const { project, prefix } = fresh()
              await run(addProject(project))
              await run(addSessions(project, prefix, mine))
              const before = await run(service.summary({ projectID: project }))

              const id = await run(addSession(project, `${prefix}_new`, added))
              const during = await run(service.summary({ projectID: project }))
              expect(during.sessions).toBe(before.sessions + 1)
              expect(during.proposed).toBe(before.proposed + added.length)
              expect(during.accepted).toBe(before.accepted + count([added], "accepted"))
              expect(during.rejected).toBe(before.rejected + count([added], "rejected"))

              await run(deleteSession(id))
              const after = await run(service.summary({ projectID: project }))
              expect(after).toEqual(before)
            }),
            { numRuns: NUM_RUNS },
          ),
        )
        ran("R4")
      }),
    TIMEOUT,
  )

  // R5: A session ID that doesn't exist or belongs to another project gives an error, not a table of zeros.
  // Kind: invariant
  // The id is either a typo'd one that was never made, or a real session that lives in another project
  // (the two cases interviewees worried about). The prefix keeps a typo from ever matching a real session.
  const missing = fc.oneof(
    fc.stringMatching(/^[A-Za-z0-9]{1,12}$/).map((typo) => ({ typo, list: [] as Decision[] })),
    decisions.map((list) => ({ typo: undefined, list })),
  )
  it.effect(
    "R5: a session id not in this project is an error, never zeros",
    () =>
      Effect.gen(function* () {
        const { service, run, addProject, addSession, addSessions } = yield* tools
        yield* Effect.promise(() =>
          fc.assert(
            fc.asyncProperty(sessions, missing, async (mine, { typo, list }) => {
              const { project, other, prefix } = fresh()
              await run(addProject(project))
              await run(addProject(other))
              await run(addSessions(project, prefix, mine))
              const sessionID =
                typo !== undefined
                  ? SessionV2.ID.make(`${prefix}_typo_${typo}`)
                  : await run(addSession(other, `${prefix}_elsewhere`, list))

              const error = await run(service.summary({ projectID: project, sessionID }).pipe(Effect.flip))
              expect(error).toBeInstanceOf(EditDecision.SessionNotFoundError)
              expect(error.sessionID).toBe(sessionID)
            }),
            { numRuns: NUM_RUNS },
          ),
        )
        ran("R5")
      }),
    TIMEOUT,
  )
})
