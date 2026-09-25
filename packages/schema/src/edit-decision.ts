export * as EditDecision from "./edit-decision"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { SessionID } from "./session-id"
import { statics } from "./schema"

export const ID = Schema.String.pipe(
  Schema.brand("EditDecision.ID"),
  statics((schema) => ({ create: () => schema.make("edc_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Decision = Schema.Literals(["accepted", "rejected"]).annotate({
  identifier: "EditDecision.Decision",
})
export type Decision = typeof Decision.Type

export const Info = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  userID: Schema.String,
  editID: Schema.String,
  decision: Decision,
  timeCreated: Schema.Number,
}).annotate({ identifier: "EditDecision.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
