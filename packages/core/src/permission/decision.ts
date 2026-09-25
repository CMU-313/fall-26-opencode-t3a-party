export * as EditDecision from "./decision"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionV2 } from "../session"
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

export interface Interface {
  readonly record: (input: RecordInput) => Effect.Effect<void>
  readonly forSession: (sessionID: SessionV2.ID) => Effect.Effect<ReadonlyArray<Info>>
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

    return Service.of({ record, forSession })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
