// R7 property first written by opencode (agent failure case in traceability/egencer.md), then strengthened by hand.
// opencode's original is kept verbatim in mutants/egencer/r7.opencode.original.test.ts.txt; it let H6 and H7 survive.
import { expect, test } from "bun:test"
import fc from "fast-check"
import { createTwoFilesPatch } from "diff"
import { trimDiff } from "../../src/tool/edit"

fc.configureGlobal({ seed: 42 })

const indentArb = fc.constantFrom(" ", "  ", "    ", "\t", "\t ")
const relativeLineArb = fc.oneof(
  fc.constant(""),
  fc.constantFrom(" ", "  ", "    ", "\t"),
  fc.stringMatching(/[a-z]{1,8}/).map((text) => `  ${text}`),
  fc.stringMatching(/[a-z]{1,8}/).map((text) => `\t${text}`),
)
// Strengthening 1 (kills H7): lines at column 0 whose text starts with "--" or "++" (an SQL comment, `++i`). Once a
// diff marker is prepended they start with "---"/"+++" like the file headers, yet they are content.
const columnZeroArb = fc.constantFrom("-- note", "--- rule", "++i")
const lineArb = (indent: string) =>
  fc.oneof(
    { weight: 4, arbitrary: relativeLineArb.map((line) => `${indent}${line}`) },
    { weight: 1, arbitrary: columnZeroArb },
  )

const inputArb = indentArb.chain((indent) =>
  fc
    // Strengthening 2 (kills H6): most lines stay the same, so the diff has non-blank context lines around the change.
    // In the original, before and after were drawn independently, so nearly every line changed and the only context
    // lines left were blank ones, which never decide the shared indent.
    .array(fc.record({ before: lineArb(indent), changed: fc.boolean(), after: lineArb(indent) }), {
      minLength: 1,
      maxLength: 8,
    })
    .map((lines) => lines.map((line) => ({ before: line.before, after: line.changed ? line.after : line.before })))
    .filter(
      (lines) =>
        lines.some((line) => line.before.trim() !== "" || line.after.trim() !== "") &&
        lines.some((line) => line.before !== line.after),
    )
    .map((lines) => ({
      indent,
      before: lines.map((line) => line.before).join("\n"),
      after: lines.map((line) => line.after).join("\n"),
    })),
)

// Strengthening 3 (kills H7): the original decided which lines are content with the same `!startsWith("---")` test as
// the implementation, so it could never disagree with it. Here the file headers are the lines before the first "@@".
const contentFlags = (lines: string[]) => {
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"))
  return lines.map((line, i) => firstHunk >= 0 && i > firstHunk && /^[+\- ]/.test(line))
}

const sharedPrefix = (a: string, b: string) => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return a.slice(0, i)
}

test("R7: an unfamiliar edit diff preserves changed lines and removes only shared indentation", () => {
  fc.assert(
    fc.property(inputArb, ({ before, after }) => {
      const raw = createTwoFilesPatch("file", "file", before, after)
      const lines = raw.split("\n")
      const content = contentFlags(lines)
      // Strengthening 4: the shared indent comes from the lines the diff shows, not the whole file. Once lines can stay
      // the same, a hunk may leave some of the file out.
      const indents = lines
        .filter((line, i) => content[i] && line.slice(1).trim() !== "")
        .map((line) => line.slice(1).match(/^\s*/)![0])
      const commonIndent = indents.length > 0 ? indents.reduce(sharedPrefix) : ""
      const expected = lines
        .map((line, i) => {
          if (!content[i]) return line
          const text = line.slice(1)
          return line[0] + text.slice(sharedPrefix(text, commonIndent).length)
        })
        .join("\n")

      expect(trimDiff(raw)).toBe(expected)
    }),
  )
})
