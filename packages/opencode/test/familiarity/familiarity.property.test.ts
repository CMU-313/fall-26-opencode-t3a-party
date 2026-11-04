// Property-based tests for unfamiliar-file warnings on AI edits. Requirement IDs refer to traceability/egencer.md.
// R1, R3, R6 drive the real permission service; R2 + R5 and R7 drive the real edit tool.

import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, expect } from "bun:test"
import { Context, Effect, Exit, Fiber } from "effect"
import fc from "fast-check"
import fs from "fs/promises"
import path from "path"
import { createTwoFilesPatch } from "diff"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { MessageID, SessionID } from "../../src/session/schema"
import { Familiarity } from "@/familiarity"
import { LSP } from "@/lsp/lsp"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { EditTool } from "../../src/tool/edit"
import * as Tool from "../../src/tool/tool"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(() => disposeAllInstances())

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Permission.node,
      Familiarity.node,
      EventV2Bridge.node,
      LSP.node,
      FSUtil.node,
      Format.node,
      Truncate.node,
      Agent.node,
      CrossSpawnSpawner.node,
    ]),
  ),
)

// fast-check calls properties as async functions; this runs an Effect inside one with the test instance's services.
const runner = Effect.gen(function* () {
  const context = yield* Effect.context<never>()
  return <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromiseWith(context as Context.Context<R>)(effect)
})

// ===============================================================================================================
// Permission-service properties (R1, R3, R6)
//
// Generators: paths come from a small pool rather than random strings, so the same file recurs across an edit's
// patterns and its unfamiliar list. The pool has nested source files, a file a teammate owns (C-1) and a protected
// directory (S-2). Rules use the shapes opencode's wildcard matcher treats differently: exact path, directory glob
// and "*", on "edit", on "*", and on unrelated permissions. Rules are last-match-wins, so each ruleset is random
// noise, then the rule that decides the case, then only rules that cannot override it.
// ===============================================================================================================

type Rule = PermissionV1.Rule
const POOL = ["src/a.ts", "src/nested/b.ts", "teammate/owned.ts", "secrets/key.ts"]
const dirGlob = (file: string) => `${file.split("/")[0]}/*`
const actionArb = fc.constantFrom<Rule["action"]>("allow", "ask", "deny")
const noiseArb = fc.array(
  fc.record({
    permission: fc.constantFrom("edit", "*", "bash"),
    pattern: fc.constantFrom("*", ...POOL, ...POOL.map(dirGlob)),
    action: actionArb,
  }),
  { maxLength: 4 },
)
// Rules on other permissions never decide an edit, so with only these, opencode's default for edits ("ask") applies.
const unrelatedArb = fc.array(
  fc.record({ permission: fc.constant("bash"), pattern: fc.constant("*"), action: actionArb }),
  {
    maxLength: 2,
  },
)

// The files one AI edit touches (several for apply_patch), which of them are unfamiliar, and a ruleset built from them.
const caseArb = (rulesetArb: (patterns: string[]) => fc.Arbitrary<Rule[]>, minUnfamiliar = 1) =>
  fc.uniqueArray(fc.constantFrom(...POOL), { minLength: 1 }).chain((patterns) =>
    fc.record({
      patterns: fc.constant(patterns),
      unfamiliarFiles: fc.subarray(patterns, { minLength: minUnfamiliar }),
      ruleset: rulesetArb(patterns),
    }),
  )
const allowedArb = caseArb(() =>
  fc
    .tuple(noiseArb, fc.constantFrom("edit", "*"), unrelatedArb)
    .map(([noise, permission, tail]) => [...noise, { permission, pattern: "*", action: "allow" as const }, ...tail]),
)
const askOnlyArb = caseArb(() => unrelatedArb)
// At least one file is denied, by its exact path, its directory glob, or "*". Any subset (even none) is unfamiliar.
const deniedArb = caseArb(
  (patterns) =>
    fc
      .tuple(noiseArb, fc.constantFrom(...patterns), fc.constantFrom("exact", "dir", "all"), unrelatedArb)
      .map(([noise, file, shape, tail]) => {
        const pattern = shape === "exact" ? file : shape === "dir" ? dirGlob(file) : "*"
        return [...noise, { permission: "edit", pattern, action: "deny" as const }, ...tail]
      }),
  0,
)

const editRequest = (input: { patterns: string[]; unfamiliarFiles: string[]; ruleset: Rule[] }) => ({
  id: PermissionV1.ID.ascending(),
  sessionID: SessionID.make("ses_property"),
  permission: "edit",
  patterns: input.patterns,
  metadata: { diff: "the diff", unfamiliarFiles: input.unfamiliarFiles },
  always: ["*"],
  ruleset: input.ruleset,
})

// Records every permission.asked event: prompts and the auto-allowed notices the UI would show.
const recordAsked = Effect.gen(function* () {
  const asked: PermissionV1.Request[] = []
  const unsub = yield* (yield* EventV2Bridge.Service).listen((event) => {
    if (event.type === Permission.Event.Asked.type) asked.push(event.data as PermissionV1.Request)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsub)
  return asked
})

const waitForPrompt = (id: PermissionV1.ID) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    while (true) {
      const prompt = (yield* permission.list()).find((item) => item.id === id)
      if (prompt) return prompt
      yield* Effect.sleep("2 millis")
    }
  }).pipe(Effect.timeout("1 second"))

const isPending = (id: PermissionV1.ID) =>
  Permission.Service.use((permission) => permission.list()).pipe(Effect.map((list) => list.some((i) => i.id === id)))

// Replies "always" to a forced unfamiliar-file prompt: the student opts into allowing unfamiliar edits (R3).
const optIn = Effect.gen(function* () {
  const permission = yield* Permission.Service
  const request = editRequest({ patterns: ["src/a.ts"], unfamiliarFiles: ["src/a.ts"], ruleset: [] })
  const fiber = yield* permission
    .ask({ ...request, ruleset: [{ permission: "edit", pattern: "*", action: "allow" }] })
    .pipe(Effect.forkScoped)
  yield* waitForPrompt(request.id)
  yield* permission.reply({ requestID: request.id, reply: "always" })
  yield* Fiber.join(fiber)
})

// R1: When the AI proposes an edit to an existing unfamiliar file, the student is prompted before it applies, even
// if their rules allow edits, unless they have opted into "always allow" for unfamiliar edits (R3).
// Kind: invariant
// For every allowing ruleset and non-empty set of unfamiliar files, the edit blocks on a forced prompt listing exactly
// those files, and proceeds only if the student approves. (Never "always", which would opt in and end R1's scope.)
it.instance("R1: an allowed edit touching unfamiliar files always waits on a prompt listing them", () =>
  Effect.gen(function* () {
    const run = yield* runner
    yield* Effect.promise(() =>
      fc.assert(
        fc.asyncProperty(allowedArb, fc.boolean(), (input, approve) =>
          run(
            Effect.gen(function* () {
              const permission = yield* Permission.Service
              const request = editRequest(input)
              const fiber = yield* permission.ask(request).pipe(Effect.forkChild)

              const prompt = yield* waitForPrompt(request.id)
              expect(prompt.metadata).toMatchObject({ unfamiliarFiles: input.unfamiliarFiles, unfamiliarForced: true })
              yield* permission.reply({ requestID: request.id, reply: approve ? "once" : "reject" })
              expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(approve)
            }),
          ),
        ),
        { numRuns: 60 },
      ),
    )
  }),
)

// R3: After the student opts into "always allow" on an unfamiliar-file prompt, later AI edits to unfamiliar files
// that their rules allow apply without a prompt, with a notice naming each unfamiliar file. Edits their rules would
// ask about are still prompted.
// Kind: invariant
// After opting in: under every allowing ruleset, the edit goes through with exactly one auto-allowed notice naming
// exactly the unfamiliar files and carrying the edit's diff (R7). Under every ask-only ruleset, the edit still waits
// on an ordinary (not forced) prompt listing the files.
it.instance("R3: after opting in, allowed unfamiliar edits go through with a notice naming every unfamiliar file", () =>
  Effect.gen(function* () {
    const asked = yield* recordAsked
    yield* optIn
    const run = yield* runner
    yield* Effect.promise(() =>
      fc.assert(
        fc.asyncProperty(
          fc.oneof(
            allowedArb,
            askOnlyArb.map((input) => ({ ...input, askOnly: true })),
          ),
          (input) =>
            run(
              Effect.gen(function* () {
                const permission = yield* Permission.Service
                const request = editRequest(input)

                if ("askOnly" in input) {
                  const fiber = yield* permission.ask(request).pipe(Effect.forkChild)
                  const prompt = yield* waitForPrompt(request.id)
                  expect(prompt.metadata).toEqual(request.metadata)
                  yield* permission.reply({ requestID: request.id, reply: "reject" })
                  yield* Fiber.await(fiber)
                  return
                }

                yield* permission.ask(request)
                expect(yield* isPending(request.id)).toBe(false)
                expect(asked.filter((item) => item.id === request.id).map((item) => item.metadata)).toEqual([
                  { ...request.metadata, unfamiliarAutoAllowed: true },
                ])
              }),
            ),
        ),
        { numRuns: 60 },
      ),
    )
  }),
)

// R6: An edit denied by a permission rule stays denied. The unfamiliar-file check never turns a deny into a prompt or
// a notice.
// Kind: invariant
// For every ruleset denying at least one of the edit's files, and any subset of unfamiliar files, the edit is denied
// with no prompt or notice. Checked before and after opting into "always allow".
it.instance("R6: a denied edit stays denied with no prompt or notice, before and after opting into always-allow", () =>
  Effect.gen(function* () {
    const asked = yield* recordAsked
    const run = yield* runner
    const property = fc.asyncProperty(deniedArb, (input) =>
      run(
        Effect.gen(function* () {
          const request = editRequest(input)
          const error = yield* Permission.Service.use((permission) => permission.ask(request)).pipe(Effect.flip)
          expect(error).toBeInstanceOf(PermissionV1.DeniedError)
          expect(asked.some((item) => item.id === request.id)).toBe(false)
        }),
      ),
    )
    yield* Effect.promise(() => fc.assert(property, { numRuns: 60 }))
    yield* optIn
    yield* Effect.promise(() => fc.assert(property, { numRuns: 60 }))
  }),
)

// ===============================================================================================================
// Edit-tool properties (R2 + R5, R7)
// ===============================================================================================================

type AskInput = Parameters<Tool.Context["ask"]>[0]

// Runs the real edit tool. `approve` plays the student: the tool's permission request is recorded, then approved or
// rejected (a rejection reaches the tool as a failure, as with the real permission service).
const runEdit = (args: Tool.InferParameters<typeof EditTool>, approve: boolean) =>
  Effect.gen(function* () {
    const asks: AskInput[] = []
    const ctx: Tool.Context = {
      sessionID: SessionID.make("ses_property"),
      messageID: MessageID.make("msg_property"),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (input) =>
        Effect.suspend(() => {
          asks.push(input)
          return approve ? Effect.void : Effect.die(new Error("rejected"))
        }),
    }
    const tool = yield* (yield* EditTool).init()
    const exit = yield* tool.execute(args, ctx).pipe(Effect.exit)
    return { ask: asks[0], applied: Exit.isSuccess(exit) }
  })

const writeFile = (file: string, content: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  })

// Generators: a run is a sequence of student actions on three existing files, so the same file is hit repeatedly and
// every ordering of approve / reject / revert comes up (C-4, C-5, S-5, S-6, O-4). Each edit spells its path as
// absolute, relative, or "dir/../dir/..." to check that familiarity follows the file, not the string. "Revert" is
// the student undoing the file by hand outside opencode (C-6): the content goes back, familiarity must not.
const FILES = ["src/a.txt", "src/nested/b.txt", "teammate/owned.txt"]
const actionsArb = fc.array(
  fc.record({
    file: fc.nat({ max: FILES.length - 1 }),
    kind: fc.constantFrom("approve", "reject", "approve", "reject", "revert"),
    spelling: fc.constantFrom("absolute", "relative", "dotdot"),
  }),
  { minLength: 1, maxLength: 12 },
)

// R2: Rejecting an AI edit to an unfamiliar file does not make the file familiar.
// R5: Once an AI edit to a file is applied, by prompt approval or under "always allow" (R3), later AI edits to that
// file are not flagged as unfamiliar while opencode runs in that project. Reverting the edit does not undo this.
// Kind: model / oracle
// The model is a plain Set of files, added to only on approval and never removed. After every action, the real edit
// tool must agree with it: the edit's prompt lists the file exactly when the model says it is unfamiliar, and only an
// approved edit changes the file.
it.instance("R2 + R5: the files an edit flags as unfamiliar match a set that only grows on approval", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const run = yield* runner
    let runIndex = 0

    yield* Effect.promise(() =>
      fc.assert(
        fc.asyncProperty(actionsArb, (actions) =>
          run(
            Effect.gen(function* () {
              // Familiarity lasts as long as the instance, so each run gets fresh files.
              const files = FILES.map((file) => `run${runIndex}/${file}`)
              runIndex++
              const content = files.map((file) => `${file} v0\n`)
              for (const [i, file] of files.entries()) yield* writeFile(path.join(test.directory, file), content[i])
              const familiar = new Set<number>()

              for (const [step, action] of actions.entries()) {
                const relative = files[action.file]
                const absolute = path.join(test.directory, relative)
                if (action.kind === "revert") {
                  content[action.file] = `${relative} v0\n`
                  yield* writeFile(absolute, content[action.file])
                  continue
                }

                const filePath =
                  action.spelling === "absolute"
                    ? absolute
                    : action.spelling === "relative"
                      ? relative
                      : relative.replace("/", "/../" + relative.split("/")[0] + "/")
                const next = `${relative} v${step + 1}\n`
                const approve = action.kind === "approve"
                const { ask, applied } = yield* runEdit(
                  { filePath, oldString: content[action.file], newString: next },
                  approve,
                )

                expect(ask.metadata.unfamiliarFiles).toEqual(familiar.has(action.file) ? [] : [absolute])
                expect(applied).toBe(approve)
                if (approve) {
                  familiar.add(action.file)
                  content[action.file] = next
                }
                expect(yield* Effect.promise(() => fs.readFile(absolute, "utf-8"))).toBe(content[action.file])
              }
            }),
          ),
        ),
        { numRuns: 40 },
      ),
    )
  }),
)

// Generators: a file is a list of code lines, each tagged "#n;" so the replaced block matches exactly once. Lines mix
// indentation (none, two or four spaces, a tab), and files often share one indent on every line (like a function
// body), because the shared indent is what the diff display trims, and mixing tabs with spaces is where trimming goes
// wrong. The edit replaces any block of lines with zero to three new ones: deletions, changes and insertions.
const linesArb = (minLength: number, maxLength: number) =>
  fc.array(
    fc
      .tuple(fc.constantFrom("", "  ", "    ", "\t"), fc.constantFrom("const x = 1", "return value", "}"))
      .map(([indent, text]) => indent + text),
    { minLength, maxLength },
  )
const editCaseArb = fc
  .record({
    shared: fc.constantFrom("", "  ", "\t"),
    lines: linesArb(1, 12),
    replacement: linesArb(0, 3),
  })
  .chain(({ shared, lines, replacement }) => {
    const render = (tag: string) => (line: string, i: number) => `${shared}${line} #${tag}${i};`
    const old = lines.map(render(""))
    return fc
      .tuple(fc.nat({ max: old.length - 1 }), fc.integer({ min: 1, max: old.length }))
      .map(([start, length]) => ({
        before: old.join("\n") + "\n",
        oldString: old.slice(start, start + length).join("\n"),
        newString: replacement.map(render("new")).join("\n"),
      }))
  })

const isContentLine = (line: string) => /^[+\- ]/.test(line) && !/^(---|\+\+\+)/.test(line)

// R7: Each notice for an AI edit applied without a prompt carries the edit's diff, showing every changed line in
// order with its indentation relative to its context. The display may only remove one indent shared by all lines.
// Kind: model / oracle
// The oracle is the untrimmed unified diff of the old and new content. The notice carries the edit tool's request
// metadata unchanged (checked by R3), so the diff in that request must match the oracle line for line, except that
// one whitespace string w, the same for every line, may be missing from the front of each content line.
it.instance("R7: the diff shown for an unfamiliar edit is the real diff, minus at most one shared indent", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const run = yield* runner
    let runIndex = 0

    yield* Effect.promise(() =>
      fc.assert(
        fc.asyncProperty(editCaseArb, (input) =>
          run(
            Effect.gen(function* () {
              const file = path.join(test.directory, `r7-${runIndex++}.txt`)
              yield* writeFile(file, input.before)
              const { ask } = yield* runEdit(
                { filePath: file, oldString: input.oldString, newString: input.newString },
                true,
              )
              const written = yield* Effect.promise(() => fs.readFile(file, "utf-8"))

              const oracle = createTwoFilesPatch(file, file, input.before, written).split("\n")
              const shown = String(ask.metadata.diff).split("\n")
              const content = oracle.findIndex(isContentLine)
              const w = oracle[content].slice(1, oracle[content].length - shown[content].length + 1)
              expect(w.trim()).toBe("")
              // Each line must lose exactly the string w, not just w.length characters of whatever whitespace it has.
              const trim = (line: string) =>
                isContentLine(line) && line.slice(1).startsWith(w) ? line[0] + line.slice(1 + w.length) : line
              expect(shown).toEqual(oracle.map(trim))
            }),
          ),
        ),
        { numRuns: 150 },
      ),
    )
  }),
)
