import * as path from "path"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly markFamiliar: (file: string) => Effect.Effect<void>
  readonly isFamiliar: (file: string) => Effect.Effect<boolean>
  readonly getUnfamiliar: (files: ReadonlyArray<string>) => Effect.Effect<string[]>
}

interface State {
  familiar: Set<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Familiarity") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Familiarity.state")(function* (ctx) {
        const value: State = { familiar: new Set() }

        // Any on-disk change counts as a student edit. AI edits land here too, but only after the student
        // accepted them, and accepted edits are marked familiar by the edit tools anyway.
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== Watcher.Event.Updated.type || event.location?.directory !== ctx.directory)
            return Effect.void
          const data = event.data as EventV2.Data<typeof Watcher.Event.Updated>
          if (data.event === "unlink") return Effect.void
          return Effect.sync(() => {
            value.familiar.add(normalize(ctx.directory, data.file))
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        return value
      }),
    )

    // Materializes the per-instance state at bootstrap so the watcher listener records student edits made
    // before the first tool call touches familiarity.
    const init = Effect.fn("Familiarity.init")(function* () {
      yield* InstanceState.get(state)
    })

    const markFamiliar = Effect.fn("Familiarity.markFamiliar")(function* (file: string) {
      const current = yield* InstanceState.get(state)
      current.familiar.add(normalize(yield* InstanceState.directory, file))
    })

    const isFamiliar = Effect.fn("Familiarity.isFamiliar")(function* (file: string) {
      const current = yield* InstanceState.get(state)
      return current.familiar.has(normalize(yield* InstanceState.directory, file))
    })

    // Returns the inputs exactly as given, so callers choose the display form (absolute or worktree-relative).
    const getUnfamiliar = Effect.fn("Familiarity.getUnfamiliar")(function* (files: ReadonlyArray<string>) {
      const current = yield* InstanceState.get(state)
      const directory = yield* InstanceState.directory
      return files.filter((file) => !current.familiar.has(normalize(directory, file)))
    })

    return Service.of({ init, markFamiliar, isFamiliar, getUnfamiliar })
  }),
)

// Resolves relative paths against the instance directory, plus symlinks and Windows casing via FSUtil,
// so "src/a.ts", "./src/a.ts" and "/proj/src/a.ts" all map to the same key.
function normalize(directory: string, file: string) {
  return FSUtil.resolve(path.resolve(directory, file))
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as Familiarity from "./familiarity"
