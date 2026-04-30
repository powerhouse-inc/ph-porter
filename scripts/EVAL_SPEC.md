# Migration Eval — design spec

Turning `scripts/batch-migrate.ts` into a Mastra-backed eval that can grade
arbitrary "migration agents" (Claude Code headless today; user-supplied Mastra
agents tomorrow) against a fixed set of Powerhouse Reactor repos.

Status: **design only**. No code written yet.

## Goals

- Reuse the existing batch-migrate orchestration (clone → checkout most-recent
  branch → inject `ph-porter` skill → run agent → run `ph-porter validate` →
  diff → parse trace → report) as the eval harness.
- Plug in alternative migration agents without touching the harness.
- Replace ad-hoc markdown reports with a structured set of scorers so runs are
  comparable across agents and across time.
- Keep the headline signal — *did `ph-porter validate` go green* — as a
  rule-based 0/1 score, with cost/turn/error-signal scorers as secondary
  metrics.

## Non-goals

- Replacing the runner with a Mastra workflow. Migration runs are 6+ minutes,
  filesystem-heavy, and call out to `pnpm`. The runner stays as plain Node;
  Mastra is the scoring/persistence library, not the orchestrator.
- Inventing a new dataset format. Test cases stay as a flat repos file.
- Auto-fixing upstream bugs. The eval surfaces signals; humans triage.

## Mastra eval primitives we use

From `@mastra/core/evals`:

- `createScorer({ id, description, type? })` — factory returning a chainable
  builder.
- `.preprocess(fn)` / `.analyze(fn)` / `.generateScore(fn)` (required) /
  `.generateReason(fn)`.
- Standalone invocation: `await scorer.run({ input, output })` — works without
  an `Agent` or `Mastra` context, returns `{ score, reason?, ... }`.
- Run shape: `run.input: string | object | Message[]`, `run.output: string |
  { text: string }`. Callbacks are untyped on extra fields, so we stash
  structured artifacts (`validateExitCode`, `diffStat`, `errorSignals`,
  `costUsd`, `numTurns`, `toolCalls`) on `run.output` and read them in the
  scorers.
- When run inside a `new Mastra({ scorers: {...} })` context, results persist
  to the `mastra_scorers` table and Studio UI lights up. Standalone runs just
  return the score object — fine for CI/cron.

Built-in scorers (`@mastra/evals`) we may layer in later: `prompt-alignment`,
`faithfulness`. Most built-ins target prompt→response quality; for migration
correctness we write our own.

## Architecture

### MigrationAgent interface

A single seam that decouples "what runs the migration" from the harness:

```ts
interface MigrationAgent {
  name: string;
  run(ctx: {
    repoDir: string;
    target: string;       // e.g. "staging" or "1.2.3" — passed to ph-porter --version
    logsDir: string;      // where to write per-agent artifacts (stream.jsonl, etc.)
  }): Promise<MigrationRun>;
}

interface MigrationRun {
  finalText: string;         // agent's end-of-run summary
  toolCalls?: ToolCall[];    // optional structured trace
  costUsd?: number;          // optional (Claude reports this; user agents may not)
  numTurns?: number;
  exitCode: number;          // 0 = agent finished cleanly; nonzero = it errored
}
```

Two implementations live alongside the harness:

- **`ClaudeCodeAgent`** — current `claude -p ... --output-format stream-json
  --verbose --dangerously-skip-permissions` spawn. The JSONL parsing already
  lives in `parse-migration-log.ts`; reuse it to populate `MigrationRun`.
- **`MastraAgent`** — accepts a user-provided Mastra `Agent` (or `Workflow`)
  via config (`--agent ./my-agent.ts` or a function passed programmatically).
  We give it a tool surface mirroring what the `ph-porter` skill expects
  (Bash, Edit, Read, Write) so the same prompt + skill text drive both
  backends. The Mastra agent's tool-call history becomes the
  `MigrationRun.toolCalls` trace.

The harness owns: clone, branch detection, skill injection, running
`ph-porter validate` *itself* (ground truth, never trusts the agent), diff
capture, scorer dispatch, aggregate report.

### Test cases

Stay in a flat file. Promote `repos.txt` to optionally accept JSON if we want
per-case `target` overrides:

```jsonc
[
  { "url": "https://github.com/powerhouse-inc/chatroom-demo", "target": "staging" },
  { "url": "https://github.com/powerhouse-inc/vetra-cloud-package", "branch": "main" }
]
```

Plain-text `repos.txt` still works (one URL per line, optional `/tree/<branch>`
or `org/repo@branch` shorthand — already supported).

### Scorer set

All custom, all rule-based unless noted. Each takes
`run.output = { text: finalText, ...artifacts }`:

1. **`validate-pass`** — `artifacts.validateExitCode === 0 ? 1 : 0`. The
   headline.
2. **`validate-step-coverage`** — fraction of the four validate steps
   (`lint:fix`, `typecheck`, `build`, `publint`) that pass. Surfaces partial
   wins.
3. **`error-signal-count`** — count of hits from
   `parseStreamJsonl().errorSignals` (ph-porter command failures, non-Bash
   tool errors, generic Bash failures). Lower is better; normalize to `1 -
   min(count/N, 1)` so the score stays in [0,1].
4. **`turn-efficiency`** — `1 - min(numTurns / SOFT_CAP, 1)`. Flags thrashing.
   Skip if the agent doesn't report turns.
5. **`cost-efficiency`** — `1 - min(costUsd / SOFT_CAP, 1)`. Skip if the agent
   doesn't report cost (Mastra agents typically won't, in this shape).
6. **`summary-faithfulness`** *(optional, LLM-graded)* — judge model receives
   the agent's `finalText` plus the actual `git diff --stat`, scores whether
   the summary matches reality. Catches confabulated reports. Use the
   built-in `faithfulness` scorer.

A composite score (weighted sum) is convenient for sorting but the per-scorer
breakdown is what surfaces upstream/CLI signal.

### Persistence + reporting

- **Standalone mode** (default): scorer results land in the existing
  `batch-migrate-logs/<repo>/summary.json` plus a per-repo `report.md`. The
  aggregate `report.md` gets a scorer-summary table.
- **Mastra mode** (when a `mastra` config is detected or `--mastra` is
  passed): wrap the runner in a `new Mastra({ scorers: {...} })` so results
  also persist to the `mastra_scorers` table. Studio observability comes for
  free.

### Directory layout (proposed)

```
scripts/
  batch-migrate.ts          # current harness — refactored to use MigrationAgent
  parse-migration-log.ts    # unchanged
  eval/
    agents/
      claude-code.ts        # ClaudeCodeAgent
      mastra.ts             # MastraAgent
    scorers/
      validate-pass.ts
      validate-step-coverage.ts
      error-signal-count.ts
      turn-efficiency.ts
      cost-efficiency.ts
      summary-faithfulness.ts
    types.ts                # MigrationAgent, MigrationRun, ToolCall
    runner.ts               # exported run-eval function
  EVAL_SPEC.md              # this doc
```

## Trade-offs and open questions

- **Mastra is overkill for orchestration here.** Built-in scorers expect
  prompt→response and don't compose with "the subject is a 6-minute headless
  CLI run that mutates a filesystem". We use `createScorer` largely as a
  structured-result + persistence layer. If that fights us, drop back to
  bespoke scoring functions and lose only the Studio UI / `mastra_scorers`
  table.
- **`run.output` shape is loose.** We rely on Mastra's untyped passthrough of
  extra fields on `run.output`. Documented but not load-bearing in the
  framework.
- **No first-class dataset abstraction.** That's fine — `repos.txt` is the
  dataset.
- **Mastra agent tool surface.** The `ph-porter` skill assumes Bash/Edit/Read
  /Write. Wrapping a Mastra agent means giving it the same tools (or a
  superset). Document the contract in `MastraAgent`'s constructor.
- **CI/cron.** Mastra docs mention CI without specifics. Keep the runner as a
  plain Node CLI; CI just runs `pnpm batch-migrate ...` and checks aggregate
  pass-rate exit code.
- **Cost of LLM-graded scorers.** `summary-faithfulness` adds judge-model
  spend per repo. Gate behind a flag.

## Implementation phasing

1. **Phase 1 — agent seam, no Mastra.** Extract `ClaudeCodeAgent` from the
   current spawn block. Pass it into the harness via a small DI hook. No
   behavior change. Ship.
2. **Phase 2 — scorer module.** Add `@mastra/core/evals`, write the rule-based
   scorers, route per-repo summary through them. Aggregate report gains a
   scorer table. Standalone mode only.
3. **Phase 3 — MastraAgent.** Add the Mastra-agent backend, document the tool
   contract, add `--agent` flag. Run the same eval against a user agent.
4. **Phase 4 (optional) — Mastra context + Studio.** Wire `new Mastra({...})`
   so results persist to the DB and Studio. Add the LLM-graded
   `summary-faithfulness` scorer behind a flag.

## Open decisions for the human

- Composite score: weighted sum vs. report-only? (Default: report-only — let
  the per-scorer numbers speak.)
- Where do logs live by default? (Today: `<repo>/batch-migrate-logs/`.
  Workspace already moved to `~/.cache/ph-porter-batch/workspace/`.)
- Promote `repos.txt` to JSON now or wait until a case actually needs
  per-row config?
