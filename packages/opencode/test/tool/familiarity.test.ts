import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Effect, Layer } from "effect"
import path from "path"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Familiarity } from "@/tool/familiarity"
import { testEffect } from "../lib/effect"

const layer = LayerNode.compile(LayerNode.group([Familiarity.node, EventV2Bridge.node, CrossSpawnSpawner.node]))
const it = testEffect(layer)
const projectsIt = testEffect(Layer.mergeAll(layer, testInstanceStoreLayer))

const init = Effect.fn("FamiliarityTest.init")(function* () {
  const familiarity = yield* Familiarity.Service
  yield* familiarity.init()
  return familiarity
})

const publishWatcher = Effect.fn("FamiliarityTest.publishWatcher")(function* (
  file: string,
  event: "add" | "change" | "unlink",
) {
  const events = yield* EventV2Bridge.Service
  yield* events.publish(Watcher.Event.Updated, { file, event })
})

// Listeners run asynchronously, so poll until the file shows up (or give up and let the assertion fail).
const waitFamiliar = Effect.fn("FamiliarityTest.waitFamiliar")(function* (file: string) {
  const familiarity = yield* Familiarity.Service
  for (let i = 0; i < 50; i++) {
    if (yield* familiarity.isFamiliar(file)) return true
    yield* Effect.sleep("10 millis")
  }
  return false
})

describe("Familiarity", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance("a file is unfamiliar until marked", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const familiarity = yield* init()
      const file = path.join(test.directory, "src", "a.ts")

      expect(yield* familiarity.isFamiliar(file)).toBe(false)
      yield* familiarity.markFamiliar(file)
      expect(yield* familiarity.isFamiliar(file)).toBe(true)
    }),
  )

  it.instance("absolute, relative and ./ paths refer to the same file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const familiarity = yield* init()

      yield* familiarity.markFamiliar(path.join(test.directory, "src", "a.ts"))

      expect(yield* familiarity.isFamiliar("src/a.ts")).toBe(true)
      expect(yield* familiarity.isFamiliar("./src/a.ts")).toBe(true)
      expect(yield* familiarity.isFamiliar("src/../src/a.ts")).toBe(true)
    }),
  )

  it.instance("getUnfamiliar returns only unfamiliar inputs, as given", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const familiarity = yield* init()
      yield* familiarity.markFamiliar(path.join(test.directory, "src", "index.ts"))

      expect(yield* familiarity.getUnfamiliar(["src/index.ts"])).toEqual([])
      expect(yield* familiarity.getUnfamiliar(["src/parser.ts"])).toEqual(["src/parser.ts"])
      expect(yield* familiarity.getUnfamiliar(["src/index.ts", "src/parser.ts", "tests/parser.ts"])).toEqual([
        "src/parser.ts",
        "tests/parser.ts",
      ])
    }),
  )

  it.instance("a student edit seen by the watcher marks the file familiar", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* init()
      const changed = path.join(test.directory, "changed.ts")
      const added = path.join(test.directory, "added.ts")

      yield* publishWatcher(changed, "change")
      yield* publishWatcher(added, "add")

      expect(yield* waitFamiliar(changed)).toBe(true)
      expect(yield* waitFamiliar(added)).toBe(true)
    }),
  )

  it.instance("a deleted file does not become familiar", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const familiarity = yield* init()
      const deleted = path.join(test.directory, "deleted.ts")
      const sentinel = path.join(test.directory, "sentinel.ts")

      yield* publishWatcher(deleted, "unlink")
      // Listeners see events in order, so once the sentinel lands the unlink has been handled.
      yield* publishWatcher(sentinel, "change")
      expect(yield* waitFamiliar(sentinel)).toBe(true)

      expect(yield* familiarity.isFamiliar(deleted)).toBe(false)
    }),
  )

  projectsIt.live("familiarity in one project does not carry over to another", () =>
    Effect.gen(function* () {
      const projectA = yield* tmpdirScoped({ git: true })
      const projectB = yield* tmpdirScoped({ git: true })

      yield* Effect.gen(function* () {
        const familiarity = yield* init()
        yield* familiarity.markFamiliar("src/foo.ts")
        expect(yield* familiarity.isFamiliar("src/foo.ts")).toBe(true)
      }).pipe(provideInstance(projectA))

      const familiarInB = yield* Effect.gen(function* () {
        const familiarity = yield* init()
        return yield* familiarity.isFamiliar("src/foo.ts")
      }).pipe(provideInstance(projectB))

      expect(familiarInB).toBe(false)
    }),
  )

  projectsIt.live("watcher events from another project are ignored", () =>
    Effect.gen(function* () {
      const projectA = yield* tmpdirScoped({ git: true })
      const projectB = yield* tmpdirScoped({ git: true })
      yield* init().pipe(provideInstance(projectA))
      yield* init().pipe(provideInstance(projectB))

      const fileInB = path.join(projectB, "src", "foo.ts")
      yield* publishWatcher(fileInB, "change").pipe(provideInstance(projectB))
      expect(yield* waitFamiliar(fileInB).pipe(provideInstance(projectB))).toBe(true)

      // Query by B's absolute path: relative paths already resolve per project, so only this shape can
      // leak if project A's listener recorded project B's event.
      const familiarInA = yield* Effect.gen(function* () {
        const familiarity = yield* Familiarity.Service
        return yield* familiarity.isFamiliar(fileInB)
      }).pipe(provideInstance(projectA))

      expect(familiarInA).toBe(false)
    }),
  )
})
