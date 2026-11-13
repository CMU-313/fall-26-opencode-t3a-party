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
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import * as Tool from "../../src/tool/tool"
import { InstanceState } from "@/effect/instance-state"
import { disposeAllInstances, TestInstance, withTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Fixed seed so mutation testing (Stryker, hand-written mutants) gives the same inputs on every run.
fc.configureGlobal({ seed: 42 })

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
    console.log("R1: passed 60 random runs")
  }),
)

// Replies "Allow always" to an ordinary (not forced) edit prompt. The edit tools send `always: ["*"]`, so this
// approves every later edit, and only R1 (unfamiliar files) can still stop one.
const approveAll = Effect.gen(function* () {
  const permission = yield* Permission.Service
  const request = editRequest({ patterns: ["src/a.ts"], unfamiliarFiles: [], ruleset: [] })
  const fiber = yield* permission.ask(request).pipe(Effect.forkScoped)
  yield* waitForPrompt(request.id)
  yield* permission.reply({ requestID: request.id, reply: "always" })
  yield* Fiber.join(fiber)
})

// R1 + R3 with several prompts pending at once.
// Kind: model / oracle
// Generators: each run starts from a fresh opencode instance in one of four states (opted into "always allow"
// for unfamiliar edits or not, an earlier "Allow always" on an ordinary prompt or not). Up to four edits, in two
// sessions, are asked at once: allowed or ask-only by the rules, with any subset of files unfamiliar (including none).
// The student then answers one pending prompt with once, always, or reject.
// The model says, for each edit, whether it applies at once, applies with a notice, or waits on a prompt (forced or
// ordinary), and after the reply, which waiting edits are released, rejected, or still waiting. In particular: an
// allowed edit with no unfamiliar files never stops (R1's scope), "always" on an ordinary prompt never opts into
// unfamiliar auto-allow, and nothing releases a waiting unfamiliar edit except the student's reply or the opt-in.
const pendingCaseArb = fc.record({
  optedIn: fc.boolean(),
  approvedAll: fc.boolean(),
  items: fc.array(
    fc.record({
      session: fc.constantFrom("ses_main", "ses_main", "ses_main", "ses_other"),
      allowed: fc.boolean(),
      unfamiliarFiles: fc.subarray(POOL),
    }),
    // At least two, so a reply to one prompt can wrongly release another.
    { minLength: 2, maxLength: 4 },
  ),
  target: fc.nat(),
  reply: fc.constantFrom<"once" | "always" | "reject">("once", "always", "always", "always", "reject"),
})

it.instance("R1 + R3: with several prompts pending, a reply releases exactly the edits the model allows", () =>
  Effect.gen(function* () {
    const run = yield* runner
    yield* Effect.promise(() =>
      fc.assert(
        fc.asyncProperty(pendingCaseArb, (input) =>
          run(
            Effect.gen(function* () {
              const permission = yield* Permission.Service
              const asked = yield* recordAsked
              if (input.optedIn) yield* optIn
              if (input.approvedAll) yield* approveAll
              let optedIn = input.optedIn
              let approvedAll = input.approvedAll

              type Status = "pending" | "applied" | "rejected"
              const items = []
              for (const item of input.items) {
                const base = editRequest({
                  patterns: item.unfamiliarFiles.length > 0 ? item.unfamiliarFiles : ["src/a.ts"],
                  unfamiliarFiles: item.unfamiliarFiles,
                  ruleset: item.allowed ? [{ permission: "edit", pattern: "*", action: "allow" }] : [],
                })
                const request = { ...base, sessionID: SessionID.make(item.session) }
                const needsAsk = !item.allowed && !approvedAll
                const unfamiliar = item.unfamiliarFiles.length > 0
                const notice = !needsAsk && unfamiliar && optedIn
                const status: Status = !needsAsk && (!unfamiliar || optedIn) ? "applied" : "pending"
                const forced = status === "pending" && !needsAsk
                const fiber = yield* permission.ask(request).pipe(Effect.exit, Effect.forkScoped)
                if (status === "pending") yield* waitForPrompt(request.id)
                else expect(Exit.isSuccess(yield* Fiber.join(fiber).pipe(Effect.timeout("1 second")))).toBe(true)

                const events = asked.filter((event) => event.id === request.id).map((event) => event.metadata)
                expect(events).toEqual(
                  notice
                    ? [{ ...request.metadata, unfamiliarAutoAllowed: true }]
                    : status === "applied"
                      ? []
                      : [forced ? { ...request.metadata, unfamiliarForced: true } : request.metadata],
                )
                items.push({ request, fiber, status: status as Status, forced, unfamiliar })
              }

              const waiting = items.filter((item) => item.status === "pending")
              if (waiting.length > 0) {
                const target = waiting[input.target % waiting.length]
                yield* permission.reply({ requestID: target.request.id, reply: input.reply })
                target.status = input.reply === "reject" ? "rejected" : "applied"
                if (input.reply === "always") {
                  if (target.forced) optedIn = true
                  else approvedAll = true
                }
                for (const item of waiting) {
                  if (item === target || item.request.sessionID !== target.request.sessionID) continue
                  if (input.reply === "reject") item.status = "rejected"
                  if (input.reply !== "always") continue
                  const ok = (optedIn && item.forced) || approvedAll
                  if (ok && !(item.unfamiliar && !optedIn)) item.status = "applied"
                }
              }

              for (const item of items) {
                if (item.status === "pending") {
                  expect(yield* isPending(item.request.id)).toBe(true)
                  continue
                }
                const exit = yield* Fiber.join(item.fiber).pipe(Effect.timeout("1 second"))
                expect(Exit.isSuccess(exit)).toBe(item.status === "applied")
                expect(yield* isPending(item.request.id)).toBe(false)
              }

              // Clean up: reject whatever is still waiting so no fiber is left behind.
              for (const item of yield* permission.list())
                yield* permission.reply({ requestID: item.id, reply: "reject" }).pipe(Effect.ignore)
            }).pipe(withTmpdirInstance(), Effect.scoped),
          ),
        ),
        { numRuns: 150 },
      ),
    )
    console.log("R1 + R3 (pending prompts): passed 150 random runs")
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
    console.log("R3: passed 60 random runs")
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
    console.log("R6: passed 60 random runs before opting into always-allow")
    yield* optIn
    yield* Effect.promise(() => fc.assert(property, { numRuns: 60 }))
    console.log("R6: passed 60 random runs after opting into always-allow")
  }),
)

// ===============================================================================================================
// Edit-tool properties (R2 + R5, R7)
// ===============================================================================================================

type AskInput = Parameters<Tool.Context["ask"]>[0]

// Runs a real file tool (edit or apply_patch). `approve` plays the student: the tool's permission request is
// recorded, then approved or rejected (a rejection reaches the tool as a failure, as with the real permission
// service). Given a ruleset instead, the request goes to the real permission service, as in a live session.
type Answer = boolean | { ruleset: Rule[] }
const runTool = <R>(execute: (ctx: Tool.Context) => Effect.Effect<unknown, unknown, R>, answer: Answer) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
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
          if (typeof answer === "object")
            return permission
              .ask({ ...input, sessionID: SessionID.make("ses_property"), ruleset: answer.ruleset })
              .pipe(Effect.orDie)
          return answer ? Effect.void : Effect.die(new Error("rejected"))
        }),
    }
    const exit = yield* execute(ctx).pipe(Effect.exit, Effect.timeout("2 seconds"), Effect.option)
    return { ask: asks[0], applied: exit._tag === "Some" && Exit.isSuccess(exit.value) }
  })
const runEdit = (args: Tool.InferParameters<typeof EditTool>, answer: Answer) =>
  runTool(
    (ctx) =>
      Effect.flatMap(
        Effect.flatMap(EditTool, (info) => info.init()),
        (tool) => tool.execute(args, ctx),
      ),
    answer,
  )
const runPatch = (args: Tool.InferParameters<typeof ApplyPatchTool>, answer: Answer) =>
  runTool(
    (ctx) =>
      Effect.flatMap(
        Effect.flatMap(ApplyPatchTool, (info) => info.init()),
        (tool) => tool.execute(args, ctx),
      ),
    answer,
  )

const writeFile = (file: string, content: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  })

// R6 end to end: the property above feeds the permission service requests built by hand, so it cannot notice the
// edit tool describing its file wrongly (e.g. no patterns), which would make every deny rule miss.
// Kind: invariant
// Generators: a fresh file, familiar or not (made familiar by an approved edit first), and a deny rule naming it by
// exact path, directory glob or "*", on "edit" or "*", after a blanket allow. For every such case, the real edit tool's
// request is denied: the edit fails, the file is unchanged, and nothing is left waiting on the student.
it.instance("R6: the edit tool's own request is denied by any deny rule naming its file, familiar or not", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const run = yield* runner
    let runIndex = 0
    yield* Effect.promise(() =>
      fc.assert(
        fc.asyncProperty(
          fc.record({
            file: fc.nat({ max: FILES.length - 1 }),
            familiar: fc.boolean(),
            shape: fc.constantFrom("exact", "dir", "all"),
            permission: fc.constantFrom("edit", "*"),
          }),
          (input) =>
            run(
              Effect.gen(function* () {
                const absolute = path.join(test.directory, `r6-${runIndex++}`, FILES[input.file])
                yield* writeFile(absolute, "v0\n")
                if (input.familiar) yield* runEdit({ filePath: absolute, oldString: "v0\n", newString: "v1\n" }, true)
                const before = yield* Effect.promise(() => fs.readFile(absolute, "utf-8"))

                const relative = path.relative((yield* InstanceState.context).worktree, absolute)
                const pattern =
                  input.shape === "exact" ? relative : input.shape === "dir" ? `${path.dirname(relative)}/*` : "*"
                const ruleset: Rule[] = [
                  { permission: "edit", pattern: "*", action: "allow" },
                  { permission: input.permission, pattern, action: "deny" },
                ]
                const { applied } = yield* runEdit(
                  { filePath: absolute, oldString: before, newString: "x\n" },
                  { ruleset },
                )

                expect(applied).toBe(false)
                expect(yield* Effect.promise(() => fs.readFile(absolute, "utf-8"))).toBe(before)
                expect(yield* Permission.Service.use((permission) => permission.list())).toEqual([])
              }),
            ),
        ),
        { numRuns: 30 },
      ),
    )
    console.log("R6 (edit tool): passed 30 random runs")
  }),
)

// Generators: a run is a sequence of student actions on three existing files, so the same file is hit repeatedly and
// every ordering of approve / reject / revert comes up (C-4, C-5, S-5, S-6, O-4). An AI change is either an edit, with
// the path spelled absolute, relative, or "dir/../dir/..." to check that familiarity follows the file, not the string,
// or a rename through apply_patch (O-5, O-6), after which the file lives at its new path. "Revert" is the student
// undoing the content by hand outside opencode (C-6): the content goes back, familiarity must not. "Create" is the AI
// creating a brand-new file, which R1 never flags (only existing files can be unfamiliar).
const FILES = ["src/a.txt", "src/nested/b.txt", "teammate/owned.txt"]
const actionsArb = fc.array(
  fc.record({
    file: fc.nat({ max: FILES.length - 1 }),
    kind: fc.constantFrom("approve", "reject", "approve", "reject", "revert", "create"),
    tool: fc.constantFrom("edit", "edit", "patch"),
    spelling: fc.constantFrom("absolute", "relative", "dotdot"),
    // A patch changes several files in one call (red team, yswc): any non-empty subset of the run's files, in any
    // order, so a familiar file often comes before an unfamiliar one. Each file is either updated or renamed.
    others: fc.shuffledSubarray([0, 1, 2], { minLength: 0 }),
    moves: fc.array(fc.boolean(), { minLength: FILES.length, maxLength: FILES.length }),
  }),
  { minLength: 1, maxLength: 12 },
)

// R2: Rejecting an AI edit to an unfamiliar file does not make the file familiar.
// R5: Once an AI edit to a file is applied, by prompt approval or under "always allow" (R3), later AI edits to that
// file are not flagged as unfamiliar while opencode runs in that project. Reverting the edit does not undo this.
// Kind: model / oracle
// The model is a plain Set of files, added to only on approval and never removed, plus each file's current path.
// After every action, the real tool must agree with it: the prompt lists the file (at the path being changed) exactly
// when the model says it is unfamiliar, only an approved change touches the disk, and a renamed file stays familiar
// at its new path. A newly created file is never listed.
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
              const prefix = `run${runIndex++}`
              const files = FILES.map((file) => `${prefix}/${file}`)
              const label = [...files]
              const content = files.map((file) => `${file} v0\n`)
              for (const [i, file] of files.entries()) yield* writeFile(path.join(test.directory, file), content[i])
              const familiar = new Set<number>()
              const read = (relative: string) =>
                Effect.promise(() => fs.readFile(path.join(test.directory, relative), "utf-8").catch(() => undefined))

              for (const [step, action] of actions.entries()) {
                const relative = files[action.file]
                const absolute = path.join(test.directory, relative)
                if (action.kind === "revert") {
                  content[action.file] = `${label[action.file]} v0\n`
                  yield* writeFile(absolute, content[action.file])
                  continue
                }

                if (action.kind === "create") {
                  const created = `${prefix}/created${step}.txt`
                  const { ask, applied } = yield* runEdit(
                    { filePath: path.join(test.directory, created), oldString: "", newString: "new file\n" },
                    true,
                  )
                  expect(ask.metadata.unfamiliarFiles).toEqual([])
                  expect(applied).toBe(true)
                  continue
                }

                const next = `${label[action.file]} v${step + 1}\n`
                const approve = action.kind === "approve"
                if (action.tool === "patch") {
                  // action.file first, then the others in their shuffled order: one apply_patch call over all of them.
                  const touched = [action.file, ...action.others.filter((i) => i !== action.file)]
                  const changes = touched.map((i) => ({
                    i,
                    from: files[i],
                    to: action.moves[i] ? `${prefix}/moved${step}/${path.basename(files[i])}` : files[i],
                    old: content[i].trimEnd(),
                    next: `${label[i]} v${step + 1}`,
                  }))
                  const patchText = [
                    "*** Begin Patch",
                    ...changes.flatMap((c) => [
                      `*** Update File: ${c.from}`,
                      ...(c.to !== c.from ? [`*** Move to: ${c.to}`] : []),
                      "@@",
                      `-${c.old}`,
                      `+${c.next}`,
                    ]),
                    "*** End Patch",
                  ].join("\n")
                  const { ask, applied } = yield* runPatch({ patchText }, approve)

                  // R1: every unfamiliar file the patch changes is flagged, in patch order, not just the first.
                  expect(ask.metadata.unfamiliarFiles).toEqual(
                    changes.filter((c) => !familiar.has(c.i)).map((c) => path.join(test.directory, c.from)),
                  )
                  // R7: the diff in the request shows every changed line of every file, in patch order.
                  const diff = String(ask.metadata.diff)
                  const positions = changes.flatMap((c) => [
                    diff.indexOf(`\n-${c.old}\n`),
                    diff.indexOf(`\n+${c.next}\n`),
                  ])
                  expect(positions.every((p) => p >= 0)).toBe(true)
                  expect(positions).toEqual([...positions].sort((a, b) => a - b))
                  expect(applied).toBe(approve)
                  for (const c of changes) {
                    if (approve) {
                      // R5: every file an approved patch changes becomes familiar, not just the first.
                      familiar.add(c.i)
                      content[c.i] = `${c.next}\n`
                      files[c.i] = c.to
                      if (c.to !== c.from) expect(yield* read(c.from)).toBeUndefined()
                    }
                    expect(yield* read(files[c.i])).toBe(content[c.i])
                  }
                  continue
                }

                const filePath =
                  action.spelling === "absolute"
                    ? absolute
                    : action.spelling === "relative"
                      ? relative
                      : relative.replace("/", "/../" + relative.split("/")[0] + "/")
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
                expect(yield* read(relative)).toBe(content[action.file])
              }
            }),
          ),
        ),
        { numRuns: 40 },
      ),
    )
    console.log("R2 + R5: passed 40 random runs")
  }),
)

// Generators: a file is a list of lines. Most are code lines, each tagged "#n;" so the replaced block matches exactly
// once. Lines mix indentation (none, two or four spaces, a tab), and files often share one indent on every code line
// (like a function body), because the shared indent is what the diff display trims, and mixing tabs with spaces is
// where trimming goes wrong. Some lines are raw, at column 0 (see rawLineArb): blank lines must not decide the
// shared indent, and "--"/"++" lines must not be mistaken for diff headers. The edit replaces a block of lines that starts at a code line with zero to three new code
// lines: deletions, changes and insertions.
const codeLineArb = fc
  .tuple(fc.constantFrom("", "  ", "    ", "\t"), fc.constantFrom("const x = 1", "return value", "}"))
  .map(([indent, text]) => ({ code: indent + text }))
// Raw lines sit at column 0 whatever the shared indent: blank or whitespace-only lines, and lines whose text starts
// with "--" or "++" (an SQL comment, a Markdown rule, `++i`). Once a diff marker is prepended, the latter look like
// the "---"/"+++" file headers, so the display must still treat them as content.
const rawLineArb = fc.constantFrom("", "  ", "\t", "-- note", "--- rule", "++count").map((raw) => ({ raw }))
type GenLine = { code: string } | { raw: string }
const editCaseArb = fc
  .record({
    shared: fc.constantFrom("", "  ", "\t"),
    lines: fc
      .array(fc.oneof({ weight: 3, arbitrary: codeLineArb }, { weight: 1, arbitrary: rawLineArb }), {
        minLength: 1,
        maxLength: 12,
      })
      .filter((lines) => lines.some((line) => "code" in line)),
    replacement: fc.array(fc.oneof({ weight: 3, arbitrary: codeLineArb }, { weight: 1, arbitrary: rawLineArb }), {
      maxLength: 3,
    }),
  })
  .chain(({ shared, lines, replacement }) => {
    const render = (tag: string) => (line: GenLine, i: number) =>
      "code" in line ? `${shared}${line.code} #${tag}${i};` : line.raw
    const old = lines.map(render(""))
    const starts = lines.flatMap((line, i) => ("code" in line ? [i] : []))
    return fc.tuple(fc.constantFrom(...starts), fc.nat()).map(([start, extra]) => ({
      before: old.join("\n") + "\n",
      oldString: old.slice(start, start + 1 + (extra % (old.length - start))).join("\n"),
      newString: replacement.map(render("new")).join("\n"),
    }))
  })

// A unified diff's "---"/"+++" file headers come before the first "@@" hunk header; every line after it that starts
// with "+", "-" or " " is content, even if its text makes it start with "---" or "+++".
const contentFlags = (lines: string[]) => {
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"))
  return lines.map((line, i) => firstHunk >= 0 && i > firstHunk && /^[+\- ]/.test(line))
}
const commonPrefix = (a: string, b: string) => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return a.slice(0, i)
}

// R7: Each notice for an AI edit applied without a prompt carries the edit's diff, showing every changed line in
// order with its indentation relative to its context. The display removes exactly the indent shared by every
// non-blank line, and nothing else.
// Kind: model / oracle
// The oracle is the untrimmed unified diff of the old and new content. The notice carries the edit tool's request
// metadata unchanged (checked by R3), so the diff in that request must equal the oracle with w removed from the front
// of each content line, where w is the longest whitespace prefix shared by all non-blank content lines. A blank or
// whitespace-only line loses only the part of w it actually has.
it.instance("R7: the diff shown for an unfamiliar edit is the real diff minus exactly its shared indent", () =>
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
              const content = contentFlags(oracle)
              const indents = oracle
                .filter((line, i) => content[i] && line.slice(1).trim() !== "")
                .map((line) => line.slice(1).match(/^\s*/)![0])
              const w = indents.length > 0 ? indents.reduce(commonPrefix) : ""
              const trim = (line: string, i: number) =>
                content[i] ? line[0] + line.slice(1 + commonPrefix(line.slice(1), w).length) : line
              expect(String(ask.metadata.diff).split("\n")).toEqual(oracle.map(trim))
            }),
          ),
        ),
        { numRuns: 150 },
      ),
    )
    console.log("R7: passed 150 random runs")
  }),
)
