import { describe, expect, test } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { Command } from "../../src/command"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"


const it = testEffect(
 Layer.mergeAll(LayerNode.compile(Command.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)


describe("Command", () => {
  it.live("registers the built-in explain command", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const command = yield* Command.Service
          const explain = yield* command.get(Command.Default.EXPLAIN)


          expect(explain).toMatchObject({
            name: "explain",
            description: "explain a file or symbol, including where it is used across the project",
            source: "command",
            hints: ["$ARGUMENTS"],
          })
          expect(explain?.subtask).toBeUndefined()


          const template = yield* Effect.promise(async () => explain!.template)
          expect(template).toContain(`\`${dir}\``)
          expect(template).not.toContain("${path}")
          expect(template).toContain("### What this does")
          expect(template).toContain("### Where it is used")
          expect(template).toContain("### Why it is structured this way")
          expect(template).toContain("No callers found elsewhere in the project.")
          expect(template).toContain("node_modules")
        }),
      { git: true },
    ),
  )


  it.live("lets a configured command override the built-in explain command", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const command = yield* Command.Service
          const explain = yield* command.get(Command.Default.EXPLAIN)


          expect(explain?.description).toBe("custom explain")
          expect(yield* Effect.promise(async () => explain!.template)).toBe("custom $1")
        }),
      { git: true, config: { command: { explain: { description: "custom explain", template: "custom $1" } } } },
    ),
  )
  test("keeps the opencode and core explain templates identical", async () => {
    const read = (file: string) => Bun.file(path.join(import.meta.dir, "../../..", file)).text()
    expect(await read("opencode/src/command/template/explain.txt")).toBe(
      await read("core/src/plugin/command/explain.txt"),
    )
  })

})
