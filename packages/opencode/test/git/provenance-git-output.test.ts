import { describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { Git } from "../../src/git"
import { GitProvenance } from "../../src/git/provenance"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Stands in for git so each test can choose exactly what `git log` returns. File validation
// still runs against a real temporary project, so only git's output is simulated.
let next: Partial<Git.Result> = {}
const fakeGit = Layer.succeed(
  Git.Service,
  Git.Service.of({
    run: (args: string[]) =>
      Effect.succeed({
        exitCode: 0,
        text: () => "",
        stderr: Buffer.from(""),
        truncated: false,
        // Only `git log` uses the configured result; the committed-length check sees the file as written
        // below, and the dirty check in context() sees a clean file.
        ...(args[0] === "cat-file" ? { text: () => "1\n2\n" } : {}),
        ...(args[0] === "log" ? next : {}),
      }),
  } as unknown as Git.Interface),
)

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(GitProvenance.node, [[Git.node, fakeGit]]),
    LayerNode.compile(CrossSpawnSpawner.node),
    testInstanceStoreLayer,
  ),
)

const withFile = <A, E, R>(body: (provenance: GitProvenance.Interface) => Effect.Effect<A, E, R>) =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(path.join(dir, "a.ts"), "1\n2\n"))
        return yield* body(yield* GitProvenance.Service)
      }),
    { git: true },
  )

const failure = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.orElseSucceed(() => undefined),
  )

const record = (hash: string, subject: string) => `${hash}\x002026-09-28T12:00:00-04:00\x00${subject}\x00`

describe("GitProvenance git output handling", () => {
  it.live("parses records, trims surrounding whitespace, and keeps separators inside a subject", () =>
    withFile((provenance) =>
      Effect.gen(function* () {
        next = { text: () => `${record("aaa", "first (#4)")}\n${record("bbb", "odd\x1f\x1esubject")}\n` }

        const result = yield* provenance.get("a.ts", 1, 2)
        expect(result).toEqual({
          truncated: false,
          commits: [
            { hash: "aaa", date: "2026-09-28T12:00:00-04:00", subject: "first (#4)", issueRefs: [4] },
            { hash: "bbb", date: "2026-09-28T12:00:00-04:00", subject: "odd\x1f\x1esubject", issueRefs: [] },
          ],
        })
      }),
    ),
  )

  it.live("fails instead of returning partial history when git output was truncated", () =>
    withFile((provenance) =>
      Effect.gen(function* () {
        next = { truncated: true, text: () => record("aaa", "partial") }

        const error = yield* failure(provenance.get("a.ts", 1, 2))
        expect(error?.reason).toBe("git-failed")
        expect(error?.message).toContain("size limit")
      }),
    ),
  )

  it.live("maps 'not a git repository' stderr to not-a-repository", () =>
    withFile((provenance) =>
      Effect.gen(function* () {
        next = { exitCode: 128, stderr: Buffer.from("fatal: not a git repository (or any parent)") }

        expect((yield* failure(provenance.get("a.ts", 1, 2)))?.reason).toBe("not-a-repository")
      }),
    ),
  )

  it.live("reports only the first stderr line, capped at 200 characters", () =>
    withFile((provenance) =>
      Effect.gen(function* () {
        next = { exitCode: 128, stderr: Buffer.from(`fatal: ${"x".repeat(300)}\nsecond line`) }

        const error = yield* failure(provenance.get("a.ts", 1, 2))
        expect(error?.reason).toBe("git-failed")
        expect(error?.message).toHaveLength(200)
        expect(error?.message).not.toContain("second line")
      }),
    ),
  )

  it.live("falls back to the exit code when git fails without stderr", () =>
    withFile((provenance) =>
      Effect.gen(function* () {
        next = { exitCode: 129, stderr: Buffer.from("") }

        const error = yield* failure(provenance.get("a.ts", 1, 2))
        expect(error?.reason).toBe("git-failed")
        expect(error?.message).toBe("git log exited with code 129")
      }),
    ),
  )

  it.live("maps git's no-history messages to errors instead of an empty history", () =>
    withFile((provenance) =>
      Effect.gen(function* () {
        for (const [stderr, reason] of [
          ["fatal: file a.ts has only 1 line", "invalid-range"],
          ["fatal: file a.ts has only 0 lines", "invalid-range"],
          ["fatal: There is no path a.ts in the commit", "untracked"],
        ] as const) {
          next = { exitCode: 128, stderr: Buffer.from(stderr) }
          expect((yield* failure(provenance.get("a.ts", 1, 2)))?.reason).toBe(reason)
        }
      }),
    ),
  )

  it.live("turns a git failure into an 'unavailable' block instead of failing the command", () =>
    withFile((provenance) =>
      Effect.gen(function* () {
        next = { exitCode: 128, stderr: Buffer.from("fatal: bad object") }

        const block = yield* provenance.context(["a.ts:1-2"])
        expect(block).toStartWith(GitProvenance.HEADER)
        expect(block).toContain("Git history is unavailable for `a.ts` lines 1-2: fatal: bad object.")
        expect(block).toContain("Do not describe or guess")
      }),
    ),
  )
})