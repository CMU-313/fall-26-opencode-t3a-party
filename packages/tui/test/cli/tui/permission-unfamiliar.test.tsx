/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { KVProvider } from "../../../src/context/kv"
import { LocationProvider } from "../../../src/context/location"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { EditBody } from "../../../src/routes/session/permission"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"

const diff = `--- a/src/parser.ts
+++ b/src/parser.ts
@@ -1 +1 @@
-const a = 1
+const a = 2
`

const request = (unfamiliarFiles?: string[]) =>
  ({
    id: "per_test",
    sessionID: "ses_test",
    permission: "edit",
    patterns: ["src/parser.ts"],
    always: ["*"],
    metadata: { filepath: "src/parser.ts", diff, ...(unfamiliarFiles ? { unfamiliarFiles } : {}) },
  }) as PermissionRequest

// KVProvider renders its children only after loading kv.json from a real state directory, and the diff
// renders over several frames, so poll until the diff is on screen before capturing.
async function renderEditBody(input: PermissionRequest) {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <LocationProvider>
                <EditBody request={input} />
              </LocationProvider>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 20 },
  )
  try {
    const start = Date.now()
    while (Date.now() - start < 2000) {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      if (frame.includes("const a = 2")) return frame
      await Bun.sleep(10)
    }
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

test("edit prompt warns about and lists unfamiliar files", async () => {
  const frame = await renderEditBody(request(["src/parser.ts", "tests/parser.ts"]))

  expect(frame).toContain("Unfamiliar files")
  expect(frame).toContain("have not previously read or edited")
  expect(frame).toContain("• src/parser.ts")
  expect(frame).toContain("• tests/parser.ts")
  expect(frame).toContain("Review these changes carefully before accepting.")
  // The diff is still shown under the warning.
  expect(frame).toContain("const a = 2")
})

test("edit prompt shows no warning when every file is familiar", async () => {
  const frame = await renderEditBody(request([]))

  expect(frame).not.toContain("Unfamiliar files")
  expect(frame).toContain("const a = 2")
})

test("edit prompt shows no warning for requests without familiarity data", async () => {
  const frame = await renderEditBody(request())

  expect(frame).not.toContain("Unfamiliar files")
  expect(frame).toContain("const a = 2")
})
