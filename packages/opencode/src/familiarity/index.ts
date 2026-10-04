import * as path from "path"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { Snapshot } from "@/snapshot"
import { SessionStatus } from "@/session/status"
import type { SessionID } from "@/session/schema"

// Tracks which files the student is familiar with — files they have read or edited themselves — so AI edits to
// anything outside that set can be surfaced before the student accepts them.
export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly markFamiliar: (file: string) => Effect.Effect<void>
  // Returns the inputs as given, minus familiar files and minus files that do not exist yet. New files are never
  // unfamiliar: their whole content is in the diff the student is about to review.
  readonly unfamiliar: (files: ReadonlyArray<string>) => Effect.Effect<string[]>
  // Records the snapshot taken after an AI step finishes, so the next turn can tell what changed meanwhile.
  readonly recordAiSnapshot: (hash: string | undefined) => Effect.Effect<void>
  // At a turn boundary, marks files changed since the last AI step familiar: those edits happened while the
  // student had control. Skipped when another session is busy so its AI edits are not attributed to the student.
  readonly markBetweenTurns: (sessionID: SessionID, snapshot: string | undefined) => Effect.Effect<void>
}

interface State {
  familiar: Set<string>
  lastAiSnapshot: string | undefined
  seeded: boolean
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Familiarity") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const snapshot = yield* Snapshot.Service
    const sessionStatus = yield* SessionStatus.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Familiarity.state")(() =>
        Effect.succeed<State>({ familiar: new Set(), lastAiSnapshot: undefined, seeded: false }),
      ),
    )

    // Seeds familiarity from git history so the student starts the session knowing the files they authored and the
    // ones they already have uncommitted work in. Git projects only; best-effort, never fatal.
    const init = Effect.fn("Familiarity.init")(function* () {
      const current = yield* InstanceState.get(state)
      if (current.seeded) return
      current.seeded = true

      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") return

      const seed = (relative: string) =>
        current.familiar.add(normalize(ctx.directory, path.resolve(ctx.worktree, relative)))

      const status = yield* git.status(ctx.worktree)
      for (const item of status) seed(item.file)

      const email = (yield* git.run(["config", "user.email"], { cwd: ctx.worktree })).text().trim()
      if (!email) return
      const log = yield* git.run(
        [
          "log",
          "--no-merges",
          "--fixed-strings",
          // Wrapped in <> so the pattern matches the author email exactly, not merely as a substring of a name.
          `--author=<${email}>`,
          "--name-only",
          "--format=",
          "-z",
          "-n",
          "1000",
          "--",
          ".",
        ],
        { cwd: ctx.worktree },
      )
      for (const file of log.text().split("\0").filter(Boolean)) seed(file)
    })

    const markFamiliar = Effect.fn("Familiarity.markFamiliar")(function* (file: string) {
      const current = yield* InstanceState.get(state)
      current.familiar.add(normalize(yield* InstanceState.directory, file))
    })

    const unfamiliar = Effect.fn("Familiarity.unfamiliar")(function* (files: ReadonlyArray<string>) {
      const current = yield* InstanceState.get(state)
      const directory = yield* InstanceState.directory
      const out: string[] = []
      for (const file of files) {
        if (current.familiar.has(normalize(directory, file))) continue
        if (!(yield* fs.existsSafe(path.resolve(directory, file)))) continue
        out.push(file)
      }
      return out
    })

    const recordAiSnapshot = Effect.fn("Familiarity.recordAiSnapshot")(function* (hash: string | undefined) {
      const current = yield* InstanceState.get(state)
      current.lastAiSnapshot = hash
    })

    const markBetweenTurns = Effect.fn("Familiarity.markBetweenTurns")(function* (
      sessionID: SessionID,
      snapshotHash: string | undefined,
    ) {
      if (!snapshotHash) return
      const current = yield* InstanceState.get(state)
      const previous = current.lastAiSnapshot
      if (!previous) return
      // Another session's AI turn may be running concurrently; its edits must not be credited to the student.
      for (const id of (yield* sessionStatus.list()).keys()) if (id !== sessionID) return

      const ctx = yield* InstanceState.context
      const files = yield* snapshot.diffNames(previous, snapshotHash)
      for (const file of files) current.familiar.add(normalize(ctx.directory, path.resolve(ctx.worktree, file)))
    })

    return Service.of({ init, markFamiliar, unfamiliar, recordAiSnapshot, markBetweenTurns })
  }),
)

// Resolves relative paths against the instance directory, plus symlinks and Windows casing via FSUtil, so
// "src/a.ts", "./src/a.ts" and "/proj/src/a.ts" all map to the same key.
function normalize(directory: string, file: string) {
  return FSUtil.resolve(path.resolve(directory, file))
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Git.node, Snapshot.node, SessionStatus.node],
})

export * as Familiarity from "."
