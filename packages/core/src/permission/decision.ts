export * as EditDecision from "./decision"

import { and, countDistinct, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { ProjectV2 } from "../project"
import { SessionV2 } from "../session"
import { SessionTable } from "../session/sql"
import { EditDecisionTable } from "./decision.sql"
import { EditDecision } from "@opencode-ai/schema/edit-decision"

export const ID = EditDecision.ID
export type ID = typeof ID.Type

export const Decision = EditDecision.Decision
export type Decision = typeof Decision.Type

export const Info = EditDecision.Info
export type Info = typeof Info.Type

export const RecordInput = Schema.Struct({
  sessionID: SessionV2.ID,
  userID: Schema.String,
  editID: Schema.String,
  decision: Decision,
}).annotate({ identifier: "EditDecision.RecordInput" })
export type RecordInput = typeof RecordInput.Type

export const SummaryInput = Schema.Struct({
  projectID: ProjectV2.ID,
  sessionID: Schema.optional(SessionV2.ID),
}).annotate({ identifier: "EditDecision.SummaryInput" })
export type SummaryInput = typeof SummaryInput.Type

// Totals of the decisions a student made on agent-proposed edits. Only edits that
// were answered are recorded, so `proposed` is always `accepted + rejected`.
export const Summary = Schema.Struct({
  sessions: Schema.Number,
  proposed: Schema.Number,
  accepted: Schema.Number,
  rejected: Schema.Number,
  acceptRatio: Schema.Number,
}).annotate({ identifier: "EditDecision.Summary" })
export type Summary = typeof Summary.Type

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()(
  "EditDecision.SessionNotFoundError",
  { sessionID: SessionV2.ID },
) {}

export interface Interface {
  readonly record: (input: RecordInput) => Effect.Effect<void>
  readonly forSession: (sessionID: SessionV2.ID) => Effect.Effect<ReadonlyArray<Info>>
  readonly summary: (input: SummaryInput) => Effect.Effect<Summary, SessionNotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/EditDecision") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const record = Effect.fn("EditDecision.record")(function* (input: RecordInput) {
      yield* db
        .insert(EditDecisionTable)
        .values({
          id: ID.create(),
          session_id: input.sessionID,
          user_id: input.userID,
          edit_id: input.editID,
          decision: input.decision,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })

    const forSession = Effect.fn("EditDecision.forSession")(function* (sessionID: SessionV2.ID) {
      const rows = yield* db
        .select()
        .from(EditDecisionTable)
        .where(eq(EditDecisionTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      return rows.map(
        (row): Info => ({
          id: row.id,
          sessionID: row.session_id,
          userID: row.user_id,
          editID: row.edit_id,
          decision: row.decision,
          timeCreated: row.time_created,
        }),
      )
    })

    const summary = Effect.fn("EditDecision.summary")(function* (input: SummaryInput) {
      // A session with no decisions and a session that does not exist both sum to zero,
      // so check existence first to give the caller a distinguishable error.
      if (input.sessionID) {
        const session = yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(and(eq(SessionTable.id, input.sessionID), eq(SessionTable.project_id, input.projectID)))
          .get()
          .pipe(Effect.orDie)
        if (!session) return yield* new SessionNotFoundError({ sessionID: input.sessionID })
      }
      const row = yield* db
        .select({
          sessions: countDistinct(EditDecisionTable.session_id),
          accepted: sql<number>`coalesce(sum(${EditDecisionTable.decision} = 'accepted'), 0)`,
          rejected: sql<number>`coalesce(sum(${EditDecisionTable.decision} = 'rejected'), 0)`,
        })
        .from(EditDecisionTable)
        .innerJoin(SessionTable, eq(SessionTable.id, EditDecisionTable.session_id))
        .where(
          and(
            eq(SessionTable.project_id, input.projectID),
            input.sessionID ? eq(EditDecisionTable.session_id, input.sessionID) : undefined,
          ),
        )
        .get()
        .pipe(Effect.orDie)
      const accepted = row?.accepted ?? 0
      const rejected = row?.rejected ?? 0
      const proposed = accepted + rejected
      return {
        sessions: row?.sessions ?? 0,
        proposed,
        accepted,
        rejected,
        acceptRatio: proposed === 0 ? 0 : accepted / proposed,
      }
    })

    return Service.of({ record, forSession, summary })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
