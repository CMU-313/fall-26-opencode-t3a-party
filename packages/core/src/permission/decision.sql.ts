import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import type { EditDecision } from "@opencode-ai/schema/edit-decision"

export const EditDecisionTable = sqliteTable(
  "edit_decision",
  {
    id: text().$type<EditDecision.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    user_id: text().notNull(),
    edit_id: text().notNull(),
    decision: text().$type<EditDecision.Decision>().notNull(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("edit_decision_edit_id_idx").on(table.edit_id)],
)
