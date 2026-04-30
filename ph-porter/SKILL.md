---
name: ph-porter
description: Use when migrating a Powerhouse Reactor project to a new stack version, validating a Reactor project (runs lint:fix, tsc, build, publint), or inspecting project state. Triggers on "migrate reactor", "powerhouse migrate", "validate reactor project", "ph-porter ...". Do NOT use for non-Powerhouse projects, generic dependency bumps, or general npm publish workflows.
license: AGPL-3.0-only
metadata:
  author: Powerhouse
  version: "0.2.6"
---

## Installation

The npm package is `@powerhousedao/ph-porter`; the installed binary is `ph-porter`.

Check first: `command -v ph-porter`. If missing, prefer the ephemeral form (no global install needed, always pulls the latest version):

```bash
pnpm dlx @powerhousedao/ph-porter <cmd>   # or: npx, bunx, yarn dlx
```

Use a global install only if the user asks for one:

```bash
npm  install -g @powerhousedao/ph-porter
pnpm add     -g @powerhousedao/ph-porter
bun  install -g @powerhousedao/ph-porter
```

## Critical

- Don't edit files inside `gen/` directories — they're regenerated. Fix the metadata source (`*.json` specs, `module.ts`, `index.ts`).
- `generateAll` regenerates but never prunes; leftover directories from renamed/removed modules need user confirmation before deletion.
- For migrations: never bypass the clean-tree check. If dirty, help the user commit/stash.
- Don't suppress errors to make `validate` pass (no `eslint-disable`, `@ts-ignore`, `--skipLibCheck` workarounds, etc.) unless the user explicitly accepts the tradeoff.

## Modes

- **Migration mode** — user wants to move to a new stack version. Confirm the target version and workdir, ensure clean git tree, run `migrate` (which auto-runs `validate` after install and prints a diff distinguishing new failures from pre-existing ones). Fix the new failures.
- **Fix mode** — user points at an existing project. Run `validate` directly to surface the current state, then fix what it finds.

## Workflow

1. Run `validate` (either standalone or via `migrate`'s post-step). It runs `lint:fix`, `tsc`, `build`, and `publint` and prints a per-step summary. After `migrate`, the summary also includes a diff that labels each failure as `NEW FAILURE`, `pre-existing`, or `fixed`.
2. Focus on `NEW FAILURE` items — those were introduced by the migration. Leave `pre-existing` failures alone unless the user asks.
3. For each new-failure step, read the captured output and fix the root cause:
    - **lint:fix** already auto-fixes what it can; remaining issues are usually rule violations needing source edits.
    - **typecheck** — edit the offending source files to satisfy the types. Don't add `// @ts-ignore` or `any` to silence errors.
    - **build** — usually downstream of typecheck or import-path issues; resolve the underlying cause, not the build flag.
    - **publint** — almost always `package.json` issues (`exports`, `files`, `main`/`types` mismatch).
4. After fixes, re-run `validate`. Repeat until no new failures remain or the remainder genuinely needs user input.
5. Verify changed files and look for potentially unwanted deletions.
6. Summarize what was fixed, what (if anything) needs the user's call, and call out any pre-existing failures so the user knows they were already there.

## Examples

### Example 1: Migrate to a new stack version

User says: "Migrate this reactor project to the most recent version."

Actions:
1. Run `ph-porter status` to record starting state and detect a dirty git tree.
2. If dirty, ask the user to commit/stash. Do not bypass the clean-tree check.
3. Run `ph-porter migrate --version latest`. The CLI auto-runs install + validate, and prints a diff labeling each failure as new vs. pre-existing.
4. Fix any step labeled `NEW FAILURE` at the root cause. Leave `pre-existing` failures alone unless the user asks.
5. Re-run `ph-porter validate` until no new failures remain.

### Example 2: Fix an existing project

User says: "Why is this powerhouse project broken?"

Actions:
1. Run `ph-porter status` to surface partial-migration symptoms (version mismatch, legacy module layouts, orphan `gen/` directories).
2. Run `ph-porter validate` to see lint / typecheck / build / publint output.
3. Fix the failing steps' root causes — edit metadata sources, never `gen/`.
4. Re-run `ph-porter validate` until green.

### Example 3: When NOT to activate

User says: "Bump the typescript version in my package.json."

This is a generic dependency bump on a non-Powerhouse project. Do not invoke ph-porter — it would refuse (no `@powerhousedao/*` deps to operate on) and the user wants a simple `npm i typescript@latest` or similar.
