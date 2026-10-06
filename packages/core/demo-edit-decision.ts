import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "./src/effect/app-node-builder"
import { LayerNode } from "./src/effect/layer-node"
import { Database } from "./src/database/database"
import { EventV2 } from "./src/event"
import { Location } from "./src/location"
import { AgentV2 } from "./src/agent"
import { PermissionV2 } from "./src/permission"
import { PermissionSaved } from "./src/permission/saved"
import { EditDecision } from "./src/permission/decision"
import { SessionStore } from "./src/session/store"
import { SessionV2 } from "./src/session"
import { SessionTable } from "./src/session/sql"
import { Project } from "./src/project"
import { ProjectTable } from "./src/project/sql"
import { AbsolutePath } from "./src/schema"

const directory = AbsolutePath.make(process.cwd())
 
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory,
    workspaceID: undefined,
    project: { id: Project.ID.global, directory },
  }),
)
 
const program = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const sessionID = SessionV2.ID.make("ses_demo_" + Date.now())
 
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
 
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "demo",
      directory,
      title: "P2B demo",
      version: "demo",
      agent: "build",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
 
  const agents = yield* AgentV2.Service
  yield* agents.transform((editor) =>
    editor.update(AgentV2.ID.make("build"), (agent) => {
      agent.permissions = []
    }),
  )
 
  const permission = yield* PermissionV2.Service
 
  console.log("\n--- Simulating a REJECTED edit ---")
  const rejected = yield* permission.ask({
    sessionID,
    action: "edit",
    resources: ["demo-file-1.ts"],
  })
  yield* permission.reply({ requestID: rejected.id, reply: "reject" })
  console.log("Replied: reject")
 
  console.log("\n--- Simulating an ACCEPTED edit ---")
  const accepted = yield* permission.ask({
    sessionID,
    action: "edit",
    resources: ["demo-file-2.ts"],
  })
  yield* permission.reply({ requestID: accepted.id, reply: "once" })
  console.log("Replied: accept (once)")
 
  const decisions = yield* EditDecision.Service
  const rows = yield* decisions.forSession(sessionID)
  console.log("\n--- Rows written to edit_decision for this session ---")
  console.log(rows)
})
 
const runtime = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    SessionStore.node,
    PermissionSaved.node,
    EditDecision.node,
    AgentV2.node,
    PermissionV2.node,
  ]),
  [[Location.node, locationLayer]],
)
 
Effect.runPromise(program.pipe(Effect.provide(runtime), Effect.scoped) as Effect.Effect<void>)
  .then(() => {
    console.log("\nDone.")
    process.exit(0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })