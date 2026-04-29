1. Run validate (either standalone or via migrate's post-step). It runs lint:fix, typecheck, build, and publint and prints a per-step summary.
2. For each failed step, read the captured output and fix the root cause:
    - lint:fix already auto-fixes what it can; remaining issues are usually rule violations needing source edits.
    - typecheck — edit the offending source files to satisfy the types. Don't add // @ts-ignore or any to silence errors.
    - build — usually downstream of typecheck or import-path issues; resolve the underlying cause, not the build flag.
    - publint — almost always package.json issues (exports, files, main/types mismatch).
3. After fixes, re-run validate. Repeat until it's green or the remaining issues genuinely need user input.
4. Verify changed files and look for potentially unwanted deletions.
5. Summarize what was fixed and what (if anything) needs the user's call.
