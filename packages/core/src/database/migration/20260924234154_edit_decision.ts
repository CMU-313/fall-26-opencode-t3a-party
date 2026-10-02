import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260924234154_edit_decision",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`edit_decision\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`user_id\` text NOT NULL,
          \`edit_id\` text NOT NULL,
          \`decision\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_edit_decision_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`edit_decision_edit_id_idx\` ON \`edit_decision\` (\`edit_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
