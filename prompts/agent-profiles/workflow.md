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
