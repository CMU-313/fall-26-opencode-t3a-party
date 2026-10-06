
# User Guide

## `/explain` command and code provenance (issues [#10](https://github.com/CMU-313/fall-26-opencode-t3a-party/issues/10) and [#21](https://github.com/CMU-313/fall-26-opencode-t3a-party/issues/21))

**`/explain` (#10)** explains a file or symbol in the context of the whole project. The answer has three sections: "What this does", "Where it is used", and "Why it is structured this way". Only searches through the project, not third parties or dependencies like `node_modules`.

**Code provenance (#21)** adds git history when you give a line range. opencode passes the commits to the model, which cites them in the "Why" section. Commit messages are treated as untrusted data.

### How to use

#### Setup

First, ensure Bun is installed on your device, then install dependencies with `bun install`.

When using opencode locally, a model provider must be configured with an API key. If you don't have one already, you can get a free one from OpenRouter. Configure it by running `bun dev auth login`, selecting your provider, and pasting in your API key.

#### Run

Start opencode with:

```bash
bun dev
```

Select your model with `Ctrl+x m`. Type `/` to see the list of commands, and select `/explain`.

The format is `/explain path/to/file:(line range)` (e.g`/explain packages/opencode/src/git/provenance.ts:180-200`).

- Without a line range (e.g `/explain path/to/file`), git history is not included.
- You can name a function instead of, or along with, a file (e.g `/explain path/to/file someFunction`).
- Without any input (e.g `/explain`), the model asks you what you want explained.

### Automated tests
The automated tests for each issue are located in:

i10 (/explain)

- `packages/opencode/test/command/command.test.ts` (Whole file)
- `packages/core/test/plugin/command.test.ts` Lines 21, 45-60
- `packages/opencode/test/session/prompt.test.ts` Lines 1710-1732 

i21 (code provenance)

- `packages/opencode/test/git/provenance.test.ts` (Whole file)
- `packages/opencode/test/git/provenance-git-output.test.ts` (Whole file)
- `packages/opencode/test/command/explain-provenance.test.ts` (Whole file)
- `packages/opencode/test/session/prompt.test.ts` Lines 1821-1947

Each test file checks:
- **`test/command/command.test.ts`** and **`packages/core/test/plugin/command.test.ts`**: `/explain` is registered correctly, its template contains every required rule, a config entry can override it, and the two template copies stay identical.
- **`test/command/explain-provenance.test.ts`**: the template tells the model to cite only the history it is given and to treat commit subjects as untrusted.
- **`test/git/provenance.test.ts`**: history lookup against temporary git repos. Covers the right commits in the right order, uncommitted code, non-git projects, invalid ranges, paths outside the project, symlinks, renames, and unusual filenames.
- **`test/git/provenance-git-output.test.ts`**: how git's output and errors are handled, using fake git output.
- **`test/session/prompt.test.ts`** (tests with "explain" in the name): end to end through the prompt pipeline. The model receives the template with the user's target, history is added only for `/explain` with a line range, a bad range doesn't break the command, and `@file` or shell syntax inside a commit message is never run.

**Why these are sufficient.** 

The output depends on the model, so the exact output can't be tested. 
 Instead, the tests prove everything that we can control and check: the command is registered, the model receives the right instructions with the user's target, and the git history it receives is correct. 

 The provenance tests also cover about 99% of the lines in `src/git/provenance.ts`, and every error case and security rule (i.e. paths outside the project, untrusted commit messages, no changes to the repo) also have their own tests.
 
  Finally, we can check whether the model follows instructions correctly by manually running and testing it.