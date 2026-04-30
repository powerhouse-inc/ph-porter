### Example 1: Migrate to a new stack version

User says: "Migrate this reactor project to the most recent version."

Actions:
1. Run `ph-porter status` to record starting state and detect a dirty git tree.
2. If dirty, ask the user to commit/stash. Do not bypass the clean-tree check.
3. Run `ph-porter migrate --version latest`. The CLI auto-runs install + validate.
4. Read the validate summary; fix any `FAILED` step at the root cause.
5. Re-run `ph-porter validate` until green.

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
