import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { Familiarity } from "@/familiarity"
import { testEffect } from "../lib/effect"

const layer = LayerNode.compile(LayerNode.group([Familiarity.node, CrossSpawnSpawner.node]))
const it = testEffect(layer)
const projectsIt = testEffect(Layer.mergeAll(layer, testInstanceStoreLayer))

const write = (file: string, content = "x\n") =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  })

describe("Familiarity", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance("a file is unfamiliar until marked", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const familiarity = yield* Familiarity.Service
      const file = path.join(test.directory, "src", "a.ts")
      yield* write(file)

      expect(yield* familiarity.unfamiliar([file])).toEqual([file])
      yield* familiarity.markFamiliar(file)
      expect(yield* familiarity.unfamiliar([file])).toEqual([])
    }),
  )

  it.instance("absolute, relative and ./ paths refer to the same file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const familiarity = yield* Familiarity.Service
      yield* write(path.join(test.directory, "src", "a.ts"))

      yield* familiarity.markFamiliar(path.join(test.directory, "src", "a.ts"))

      expect(yield* familiarity.unfamiliar(["src/a.ts"])).toEqual([])
      expect(yield* familiarity.unfamiliar(["./src/a.ts"])).toEqual([])
      expect(yield* familiarity.unfamiliar(["src/../src/a.ts"])).toEqual([])
    }),
  )

  it.instance("unfamiliar returns only unfamiliar inputs that exist, as given", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const familiarity = yield* Familiarity.Service
      yield* write(path.join(test.directory, "src", "index.ts"))
      yield* write(path.join(test.directory, "src", "parser.ts"))
      yield* write(path.join(test.directory, "tests", "parser.ts"))
      yield* familiarity.markFamiliar(path.join(test.directory, "src", "index.ts"))

      expect(yield* familiarity.unfamiliar(["src/index.ts"])).toEqual([])
      expect(yield* familiarity.unfamiliar(["src/parser.ts"])).toEqual(["src/parser.ts"])
      expect(yield* familiarity.unfamiliar(["src/index.ts", "src/parser.ts", "tests/parser.ts"])).toEqual([
        "src/parser.ts",
        "tests/parser.ts",
      ])
    }),
  )

  it.instance("a file that does not exist yet is never unfamiliar", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const familiarity = yield* Familiarity.Service
      expect(yield* familiarity.unfamiliar([path.join(test.directory, "brand-new.ts")])).toEqual([])
    }),
  )

  projectsIt.live("familiarity in one project does not carry over to another", () =>
    Effect.gen(function* () {
      const projectA = yield* tmpdirScoped({ git: true })
      const projectB = yield* tmpdirScoped({ git: true })

      yield* Effect.gen(function* () {
        const familiarity = yield* Familiarity.Service
        const file = path.join(projectA, "src", "foo.ts")
        yield* write(file)
        yield* familiarity.markFamiliar(file)
        expect(yield* familiarity.unfamiliar([file])).toEqual([])
      }).pipe(provideInstance(projectA))

      const unfamiliarInB = yield* Effect.gen(function* () {
        const familiarity = yield* Familiarity.Service
        const file = path.join(projectB, "src", "foo.ts")
        yield* write(file)
        return yield* familiarity.unfamiliar([file])
      }).pipe(provideInstance(projectB))

      expect(unfamiliarInB).toEqual([path.join(projectB, "src", "foo.ts")])
    }),
  )
})
