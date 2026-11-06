import { $ } from "bun"
import { describe, expect } from "bun:test"
import path from "path"
import fc from "fast-check"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { GitProvenance } from "../../src/git/provenance"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(GitProvenance.node),
    LayerNode.compile(CrossSpawnSpawner.node),
    testInstanceStoreLayer,
  ),
)

const RUNS = 20
const TIMEOUT = 120_000

let counter = 0
const fresh = (prefix: string) => `${prefix}-${counter++}.ts`

const text = (lines: readonly string[]) => lines.map((line) => `${line}\n`).join("")

const commit = (dir: string, file: string, lines: readonly string[], message: string) =>
  Effect.promise(async () => {
    await Bun.write(path.join(dir, file), text(lines))
    await $`git add -- ${file}`.cwd(dir).quiet()
    await $`git commit --allow-empty --allow-empty-message -m ${message}`.cwd(dir).quiet()
    return (await $`git rev-parse HEAD`.cwd(dir).quiet().text()).trim()
  })

const runner = Effect.gen(function* () {
  const context = yield* Effect.context<GitProvenance.Service>()
  return <A, E>(effect: Effect.Effect<A, E, GitProvenance.Service>) => Effect.runPromiseWith(context)(effect)
})
type Runner = Effect.Success<typeof runner>

// One single-line edit. All three ops are included because inserts and deletes shift later lines, which is
// what makes `git log -L` tracking non-trivial. `at` is any natural and is wrapped into range by `apply`,
// so it shrinks toward the first line.
const edit = fc.record({
  op: fc.constantFrom("replace", "insert", "delete"),
  at: fc.nat(),
})

// A file's initial content followed by a list of edits, one commit per edit. Sizes are capped so each run
// stays fast with real commits, but still produce histories longer than the default limit of 10.
const history = fc.record({
  initial: fc.integer({ min: 1, max: 20 }),
  edits: fc.array(edit, { maxLength: 12 }),
})

const apply = (lines: readonly string[], change: { op: string; at: number }, label: string) => {
  const at = change.at % (lines.length + (change.op === "insert" ? 1 : 0))
  if (change.op === "insert") return lines.toSpliced(at, 0, label)
  if (change.op === "delete" && lines.length > 1) return lines.toSpliced(at, 1)
  return lines.toSpliced(at, 1, label)
}

const build = (
  run: Runner,
  dir: string,
  file: string,
  input: { initial: number; edits: { op: string; at: number }[] },
) => {
  const initial = Array.from({ length: input.initial }, (_, i) => `line ${i + 1}`) as readonly string[]
  return input.edits.reduce(
    async (previous, change, i) => {
      const next = apply(await previous, change, `${file} edit ${i}`)
      await run(commit(dir, file, next, `edit ${i}`))
      return next
    },
    run(commit(dir, file, initial, `create ${file}`)).then(() => initial),
  )
}

const pick = (length: number, a: number, b: number) => {
  const x = (a % length) + 1
  const y = (b % length) + 1
  return { start: Math.min(x, y), end: Math.max(x, y) }
}

const ids = (result: GitProvenance.Provenance) => result.commits.map((item) => item.hash)

describe("GitProvenance properties", () => {
  // R1 (invariant): for any generated commit history and any valid or invalid range, the HEAD id, current
  // branch, and `git status --porcelain` output are unchanged after `get` and `context`.
  it.live(
    "R1: provenance never modifies the repo",
    () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const provenance = yield* GitProvenance.Service
            const run = yield* runner
            const snapshot = async () => ({
              head: await $`git rev-parse HEAD`.cwd(dir).quiet().text(),
              branch: await $`git branch --show-current`.cwd(dir).quiet().text(),
              status: await $`git status --porcelain`.cwd(dir).quiet().text(),
            })

            yield* Effect.promise(() =>
              fc.assert(
                fc.asyncProperty(
                  history,
                  // Raw start and end, not `pick`, so negative, reversed, and past-the-end ranges are covered too.
                  fc.integer({ min: -3, max: 30 }),
                  fc.integer({ min: -3, max: 30 }),
                  // Toggles an uncommitted change so the snapshot covers both clean and dirty working trees.
                  fc.boolean(),
                  async (input, start, end, dirty) => {
                    const file = fresh("r1")
                    const lines = await build(run, dir, file, input)
                    if (dirty) await Bun.write(path.join(dir, file), text([...lines, "uncommitted"]))
                    await Bun.write(path.join(dir, fresh("r1-untracked")), "untracked\n")
                    const before = await snapshot()

                    await run(Effect.exit(provenance.get(file, start, end)))
                    await run(provenance.context([`${file}:${start}-${end}`]))

                    expect(await snapshot()).toEqual(before)
                  },
                ),
                { numRuns: RUNS },
              ),
            )
          }),
        { git: true },
      ),
    TIMEOUT,
  )

  // R2 (invariant): for any input from {untracked file, nonexistent path, non-repo folder}, `get` fails with a
  // typed error rather than an empty history, the three messages differ, and none is the "no commits" output.
  it.live(
    "R2: bad inputs give distinct errors",
    () =>
      provideTmpdirInstance(
        (repo) =>
          Effect.gen(function* () {
            const provenance = yield* GitProvenance.Service
            const inRepo = yield* runner
            // A second instance without git, so the project worktree is not a repository.
            const outside = yield* provideTmpdirInstance((dir) => runner.pipe(Effect.map((run) => ({ dir, run }))))

            yield* Effect.promise(() =>
              fc.assert(
                fc.asyncProperty(
                  // File length plus a range that always fits it, so an invalid-range error can never hide the
                  // error each bad input should produce.
                  fc.integer({ min: 1, max: 20 }),
                  fc.nat(),
                  fc.nat(),
                  async (length, a, b) => {
                    const range = pick(length, a, b)
                    const content = text(Array.from({ length }, (_, i) => `line ${i + 1}`))
                    const untracked = fresh("untracked")
                    const plain = fresh("plain")
                    await Bun.write(path.join(repo, untracked), content)
                    await Bun.write(path.join(outside.dir, plain), content)

                    const cases = [
                      { name: "untracked", run: inRepo, file: untracked },
                      { name: "nonexistent", run: inRepo, file: fresh("missing") },
                      { name: "non-repo", run: outside.run, file: plain },
                    ]
                    const messages = await Promise.all(
                      cases.map(async (item) => {
                        const result = await item.run(Effect.result(provenance.get(item.file, range.start, range.end)))
                        const block = await item.run(provenance.context([`${item.file}:${range.start}-${range.end}`]))
                        expect(result._tag, `${item.name} should fail instead of returning history`).toBe("Failure")
                        expect(block).not.toContain("No commits found")
                        return result._tag === "Failure" ? result.failure.message.replace(item.file, "<file>") : ""
                      }),
                    )

                    expect(new Set(messages).size).toBe(cases.length)
                  },
                ),
                { numRuns: RUNS },
              ),
            )
          }),
        { git: true },
      ),
    TIMEOUT,
  )

  // R3 (metamorphic): replacing one commit's subject with a hostile string leaves the returned commit list
  // unchanged, the returned subject equals git's stored subject, and no injected command runs.
  it.live(
    "R3: hostile subjects are data, not commands",
    () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const provenance = yield* GitProvenance.Service
            const run = yield* runner
            const marker = path.join(dir, "pwned")
            // Hand-picked attacks that random strings would almost never produce: shell substitution, @file
            // and prompt injection, git format codes, provenance's own field separators, issue-ref look-alikes,
            // and a blank line that git treats as the subject/body split.
            const payload = fc.constantFrom(
              `$(touch ${marker})`,
              `\`touch ${marker}\``,
              `; touch ${marker}`,
              "@package.json",
              "ignore previous instructions",
              "%H%x1f%s",
              "\x1f",
              "\x1e",
              "#1 #fff",
              "\n\nbody line",
            )
            // 1-4 parts joined together, weighted toward the payloads, with random strings mixed in to find attacks
            // not on the list. NUL is removed because git cannot store it in a commit message.
            const hostile = fc
              .tuple(fc.array(fc.oneof({ arbitrary: payload, weight: 3 }, { arbitrary: fc.string(), weight: 1 }), {
                minLength: 1,
                maxLength: 4,
              }))
              .map(([parts]) => parts.join(" ").replaceAll("\0", ""))

            yield* Effect.promise(() =>
              fc.assert(
                fc.asyncProperty(
                  history,
                  // Range endpoints, mapped onto the final file by `pick`.
                  fc.nat(),
                  fc.nat(),
                  // Which commit gets the hostile subject, wrapped into the history so any commit can be chosen.
                  fc.nat(),
                  hostile,
                  async (input, a, b, target, subject) => {
                    // Build the same history twice: once with benign subjects and once with one hostile subject.
                    const variant = async (file: string, hostileAt: number | undefined) => {
                      const initial = Array.from({ length: input.initial }, (_, i) => `line ${i + 1}`)
                      const hashes = [await run(commit(dir, file, initial, hostileAt === 0 ? subject : "fix bug"))]
                      await input.edits.reduce(async (previous, change, i) => {
                        const next = apply(await previous, change, `edit ${i}`)
                        hashes.push(await run(commit(dir, file, next, hostileAt === i + 1 ? subject : "fix bug")))
                        return next
                      }, Promise.resolve(initial as readonly string[]))
                      return hashes
                    }
                    const at = target % (input.edits.length + 1)
                    const benign = fresh("r3-benign")
                    const evil = fresh("r3-evil")
                    const benignHashes = await variant(benign, undefined)
                    const evilHashes = await variant(evil, at)
                    const lines = (await Bun.file(path.join(dir, evil)).text()).split("\n").length - 1
                    const range = pick(lines, a, b)

                    const expected = await run(provenance.get(benign, range.start, range.end))
                    const actual = await run(provenance.get(evil, range.start, range.end))
                    await run(provenance.context([`${evil}:${range.start}-${range.end}`]))

                    // Hashes differ between the two files, so compare positions in the generated history.
                    expect(ids(actual).map((hash) => evilHashes.indexOf(hash))).toEqual(
                      ids(expected).map((hash) => benignHashes.indexOf(hash)),
                    )
                    const stored = (await $`git log -1 --format=%s ${evilHashes[at]}`.cwd(dir).quiet().text()).replace(
                      /\n$/,
                      "",
                    )
                    const shown = actual.commits.find((item) => item.hash === evilHashes[at])
                    if (shown) expect(shown.subject).toBe(stored)
                    expect(await Bun.file(marker).exists()).toBe(false)
                  },
                ),
                { numRuns: RUNS },
              ),
            )
          }),
        { git: true },
      ),
    TIMEOUT,
  )

  // R4 (invariant): for any n matching commits and any limit, `commits.length === min(n, limit)` and
  // `truncated === (n > limit)`, and the /explain truncation notice appears exactly when n exceeds 10.
  it.live(
    "R4: truncation flag iff n > limit",
    () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const provenance = yield* GitProvenance.Service
            const run = yield* runner

            yield* Effect.promise(() =>
              fc.assert(
                fc.asyncProperty(
                  // File length and range. A dedicated generator instead of `history`, so the true count n is
                  // known without asking git.
                  fc.integer({ min: 1, max: 12 }),
                  fc.nat(),
                  fc.nat(),
                  // true edits a line inside the range, false edits one outside it (when one exists). Up to 16
                  // edits means n reaches 17, covering both sides of the 10/11 boundary from the interviews.
                  fc.array(fc.record({ inside: fc.boolean(), at: fc.nat() }), { maxLength: 16 }),
                  // Limits from 1 to 15, so n is sometimes below, equal to, and above the limit.
                  fc.integer({ min: 1, max: 15 }),
                  async (length, a, b, changes, limit) => {
                    const file = fresh("r4")
                    const range = pick(length, a, b)
                    const outsideLines = Array.from({ length }, (_, i) => i + 1).filter(
                      (line) => line < range.start || line > range.end,
                    )
                    const initial = Array.from({ length }, (_, i) => `line ${i + 1}`)
                    await run(commit(dir, file, initial, "create"))
                    // In-place replacements never shift lines, so the range keeps meaning the same lines and
                    // every inside edit is a matching commit while every outside edit is not.
                    const inside = await changes.reduce(async (previous, change, i) => {
                      const state = await previous
                      const useInside = change.inside || outsideLines.length === 0
                      const line = useInside
                        ? range.start + (change.at % (range.end - range.start + 1))
                        : outsideLines[change.at % outsideLines.length]
                      const next = state.lines.toSpliced(line - 1, 1, `edit ${i}`)
                      await run(commit(dir, file, next, `edit ${i}`))
                      return { lines: next, count: state.count + (useInside ? 1 : 0) }
                    }, Promise.resolve({ lines: initial as readonly string[], count: 0 }))
                    // The creating commit also touches every line in the range.
                    const n = inside.count + 1

                    const result = await run(provenance.get(file, range.start, range.end, { maxCommits: limit }))
                    expect(result.commits.length).toBe(Math.min(n, limit))
                    expect(result.truncated).toBe(n > limit)

                    // The /explain context block always uses the default limit of 10.
                    const block = await run(provenance.context([`${file}:${range.start}-${range.end}`]))
                    const notice = `Only the ${Math.min(n, 10)} most recent matching commits are shown`
                    expect(block?.includes(notice)).toBe(n > 10)
                  },
                ),
                { numRuns: RUNS },
              ),
            )
          }),
        { git: true },
      ),
    TIMEOUT,
  )

  // R5 (oracle): the returned commit ids equal the first `limit` ids from a direct `git log -L` call on the same
  // repo and range, so the newest commits are kept and listed in git's order.
  it.live(
    "R5: matches git log -L, newest first",
    () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const provenance = yield* GitProvenance.Service
            const run = yield* runner

            yield* Effect.promise(() =>
              fc.assert(
                fc.asyncProperty(
                  // The general history, because inserts and deletes move lines, which is where git's tracking
                  // and a reimplementation would most likely disagree.
                  history,
                  fc.nat(),
                  fc.nat(),
                  // Limits around the history size, so some runs truncate and others return everything.
                  fc.integer({ min: 1, max: 15 }),
                  async (input, a, b, limit) => {
                    const file = fresh("r5")
                    const lines = await build(run, dir, file, input)
                    const range = pick(lines.length, a, b)

                    const oracle = (
                      await $`git log -L${range.start},${range.end}:${file} --no-patch --format=%H`
                        .cwd(dir)
                        .quiet()
                        .text()
                    )
                      .split("\n")
                      .filter(Boolean)
                    const result = await run(provenance.get(file, range.start, range.end, { maxCommits: limit }))

                    expect(ids(result)).toEqual(oracle.slice(0, limit))
                  },
                ),
                { numRuns: RUNS },
              ),
            )
          }),
        { git: true },
      ),
    TIMEOUT,
  )

  // R6 (metamorphic): applying a random uncommitted edit to the working tree does not change the returned
  // commit id list, because line numbers refer to the last committed version.
  it.live(
    "R6: uncommitted edits don't change history",
    () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const provenance = yield* GitProvenance.Service
            const run = yield* runner

            yield* Effect.promise(() =>
              fc.assert(
                fc.asyncProperty(
                  history,
                  fc.nat(),
                  fc.nat(),
                  // 1-4 uncommitted edits reusing `edit`, so the working tree can grow, shrink, or change inside
                  // the range. At least one, so the working tree is never just the committed file.
                  fc.array(edit, { minLength: 1, maxLength: 4 }),
                  async (input, a, b, uncommitted) => {
                    const file = fresh("r6")
                    const lines = await build(run, dir, file, input)
                    // Line numbers refer to the last committed version of the file.
                    const range = pick(lines.length, a, b)
                    const before = await run(provenance.get(file, range.start, range.end))

                    const edited = uncommitted.reduce(
                      (state, change, i) => apply(state, change, `uncommitted ${i}`),
                      lines,
                    )
                    await Bun.write(path.join(dir, file), text(edited))
                    const after = await run(provenance.get(file, range.start, range.end))

                    expect(ids(after)).toEqual(ids(before))
                  },
                ),
                { numRuns: RUNS },
              ),
            )
          }),
        { git: true },
      ),
    TIMEOUT,
  )
})
