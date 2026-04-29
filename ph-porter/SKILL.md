---
name: ph-porter
description: Use when migrating a Powerhouse Reactor project to a new stack version, validating a Reactor project (lint/typecheck/build/publint), or inspecting project state. Triggers on "migrate reactor", "powerhouse migrate", "validate reactor project", "ph-porter ...", or any project depending on `@powerhousedao/*`.
metadata:
  author: Powerhouse
  version: "1.0.0"
---

# ph-porter

CLI for migrating Powerhouse Reactor projects between stack versions.

## Install

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

## Commands

Run from the project directory, or pass `--workdir <path>`.

- **`status`** — read-only. Reports git state, package manager, `@powerhousedao/*` version coherence, required scripts, and module layout (flags `LEGACY` / `MIXED` / `ORPHAN` directories). Run this first.
- **`migrate <version>`** — destructive. `<version>` is a semver (`1.2.3`) or dist-tag (`latest`, `staging`, `dev`). Requires a clean git tree (the rollback is `git restore .`). Auto-runs install + validate.
- **`validate`** — runs `lint:fix`, `tsc --noEmit`, `build`, and `publint` and prints a per-step summary. Missing scripts are skipped, not failed.
- **`selfUpdate [--check]`** — bump the installed CLI to the latest npm version.

## Guardrails

- **Don't edit `gen/` directories** — they're regenerated. Fix the metadata source: `*.json` for document-models, `module.ts` for editors/processors, `index.ts` for subgraphs.
- **Don't bypass the clean-tree check** for migrate. If dirty, help the user commit/stash.
- **Don't suppress errors** to make `validate` pass (`@ts-ignore`, `eslint-disable`, dropping types from tsconfig). Fix the root cause.
- **`generateAll` doesn't prune.** Renamed/removed modules leave their old directory behind — confirm with the user before deleting.

## Known issue: codegen staleness

ph-porter ships with a fixed `@powerhousedao/codegen` version. If the user is migrating to a newer stack than the bundled codegen knows, results may use older templates. `status` shows whether a newer ph-porter is published; using the dlx form (above) sidesteps the issue.
