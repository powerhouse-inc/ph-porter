import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
    ValidationResult,
    ValidationStep,
    ValidationStepName,
} from "../commands/validate.js";

/**
 * Per-workdir storage for ph-porter validation results. Each saved result
 * lives under `<workdir>/.ph/ph-porter/results/<name>.json`. `.ph/` is
 * gitignored by the project scaffold so saving doesn't dirty the tree.
 *
 * Agents save named snapshots (e.g. before migrating, after migrating) and
 * compare any pair via `--diff <name>`. Names are user-supplied — the CLI
 * does not auto-generate them.
 */
const RESULTS_DIR = join(".ph", "ph-porter", "results");
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

interface GitInfo {
    commit: string;
    branch: string;
    dirty: boolean;
}

export interface SavedValidation {
    savedAt: string;
    phPorterVersion: string | null;
    projectPhCliVersion: string | null;
    requestedSteps: ValidationStepName[] | null;
    git: GitInfo | null;
    steps: ValidationStep[];
}

export interface SavedValidationEntry {
    name: string;
    file: string;
    saved: SavedValidation;
}

function readPhPorterVersion(): string | null {
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        // src/services/ -> ../../package.json (works from both src and dist).
        const pkgPath = resolve(here, "..", "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
            version?: string;
        };
        return pkg.version ?? null;
    } catch {
        return null;
    }
}

function readProjectPhCliVersion(workdir: string): string | null {
    try {
        const pkg = JSON.parse(
            readFileSync(join(workdir, "package.json"), "utf8"),
        ) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        const name = "@powerhousedao/ph-cli";
        return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? null;
    } catch {
        return null;
    }
}

function readGitInfo(workdir: string): GitInfo | null {
    const run = (args: string[]): string | null => {
        try {
            return execFileSync("git", args, {
                cwd: workdir,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
        } catch {
            return null;
        }
    };
    const commit = run(["rev-parse", "HEAD"]);
    if (!commit) return null;
    const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "";
    const status = run(["status", "--porcelain"]) ?? "";
    return { commit, branch, dirty: status.length > 0 };
}

export function resultsDir(workdir: string): string {
    return join(workdir, RESULTS_DIR);
}

export function resultFile(workdir: string, name: string): string {
    return join(resultsDir(workdir), `${name}.json`);
}

function assertValidName(name: string): void {
    if (!NAME_PATTERN.test(name)) {
        throw new Error(
            `Invalid result name "${name}". Allowed characters: letters, digits, dot, underscore, hyphen.`,
        );
    }
}

export function listResults(workdir: string): SavedValidationEntry[] {
    const dir = resultsDir(workdir);
    if (!existsSync(dir)) return [];
    const entries: SavedValidationEntry[] = [];
    for (const filename of readdirSync(dir)) {
        if (!filename.endsWith(".json")) continue;
        const name = filename.slice(0, -".json".length);
        const file = join(dir, filename);
        try {
            const saved = JSON.parse(
                readFileSync(file, "utf8"),
            ) as SavedValidation;
            if (!Array.isArray(saved.steps)) continue;
            entries.push({ name, file, saved });
        } catch {
            // Skip unreadable or malformed files.
            continue;
        }
    }
    // Newest first.
    entries.sort((a, b) => b.saved.savedAt.localeCompare(a.saved.savedAt));
    return entries;
}

export function readResult(
    workdir: string,
    name: string,
): SavedValidationEntry | null {
    assertValidName(name);
    const file = resultFile(workdir, name);
    if (!existsSync(file)) return null;
    try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as SavedValidation;
        if (!Array.isArray(saved.steps)) return null;
        return { name, file, saved };
    } catch {
        return null;
    }
}

export function writeResult(
    workdir: string,
    name: string,
    result: ValidationResult,
    options?: { requestedSteps?: readonly ValidationStepName[] },
): { name: string; file: string } {
    assertValidName(name);
    const dir = resultsDir(workdir);
    mkdirSync(dir, { recursive: true });
    const file = resultFile(workdir, name);
    const payload: SavedValidation = {
        savedAt: new Date().toISOString(),
        phPorterVersion: readPhPorterVersion(),
        projectPhCliVersion: readProjectPhCliVersion(workdir),
        requestedSteps: options?.requestedSteps
            ? [...options.requestedSteps]
            : null,
        git: readGitInfo(workdir),
        steps: result.steps,
    };
    writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
    return { name, file };
}

export type DiffCategory =
    | "new-failure"
    | "pre-existing"
    | "fixed"
    | "unchanged"
    | "missing-in-saved";

/**
 * For pre-existing failures, whether the captured output changed between the
 * saved run and the current run.
 *  - "same": outputs are byte-identical (probably the same set of issues).
 *  - "changed": outputs differ — could be more, fewer, or different issues.
 *  - "unknown": output wasn't captured on one or both sides (e.g. the saved
 *    result predates output capture).
 */
export type OutputChange = "same" | "changed" | "unknown";

export interface StepDiff {
    name: string;
    category: DiffCategory;
    savedSuccess: boolean | null;
    currentSuccess: boolean;
    currentSkipped: boolean;
    /** Aggregate of stdout+stderr change between saved and current. */
    outputChange?: OutputChange;
    savedOutputBytes?: number;
    currentOutputBytes?: number;
}

export interface ValidationDiff {
    againstName: string;
    againstSavedAt: string;
    againstGit: GitInfo | null;
    againstPhPorterVersion: string | null;
    againstProjectPhCliVersion: string | null;
    againstRequestedSteps: ValidationStepName[] | null;
    diffs: StepDiff[];
    newFailures: StepDiff[];
}

export function diffAgainst(
    against: SavedValidationEntry,
    current: ValidationResult,
): ValidationDiff {
    const saved = against.saved;
    const savedByName = new Map<string, ValidationStep>();
    for (const s of saved.steps) savedByName.set(s.name, s);

    const diffs: StepDiff[] = current.steps.map((s) => {
        const b = savedByName.get(s.name);
        const savedSuccess = b ? b.success : null;
        const currentSuccess = s.skipped ? true : s.success;
        let category: DiffCategory;
        if (!b) category = "missing-in-saved";
        else if (!b.success && currentSuccess) category = "fixed";
        else if (b.success && !currentSuccess) category = "new-failure";
        else if (!b.success && !currentSuccess) category = "pre-existing";
        else category = "unchanged";

        // For pre-existing failures, surface whether stdout/stderr changed.
        let outputChange: OutputChange | undefined;
        let savedOutputBytes: number | undefined;
        let currentOutputBytes: number | undefined;
        if (category === "pre-existing" && b) {
            const savedAny = b.stdout !== undefined || b.stderr !== undefined;
            const currentAny = s.stdout !== undefined || s.stderr !== undefined;
            savedOutputBytes =
                (b.stdout?.length ?? 0) + (b.stderr?.length ?? 0);
            currentOutputBytes =
                (s.stdout?.length ?? 0) + (s.stderr?.length ?? 0);
            if (!savedAny || !currentAny) {
                outputChange = "unknown";
            } else {
                outputChange =
                    b.stdout === s.stdout && b.stderr === s.stderr
                        ? "same"
                        : "changed";
            }
        }

        return {
            name: s.name,
            category,
            savedSuccess,
            currentSuccess,
            currentSkipped: s.skipped,
            outputChange,
            savedOutputBytes,
            currentOutputBytes,
        };
    });

    const newFailures = diffs.filter((d) => d.category === "new-failure");
    return {
        againstName: against.name,
        againstSavedAt: saved.savedAt,
        againstGit: saved.git ?? null,
        againstPhPorterVersion: saved.phPorterVersion ?? null,
        againstProjectPhCliVersion: saved.projectPhCliVersion ?? null,
        againstRequestedSteps: saved.requestedSteps ?? null,
        diffs,
        newFailures,
    };
}

export function formatSavedResult(
    entry: SavedValidationEntry,
    options?: { steps?: readonly ValidationStepName[] },
): string {
    const s = entry.saved;
    const filter = options?.steps ? new Set(options.steps) : null;
    const lines: string[] = [];
    const gitLabel = s.git
        ? `${s.git.branch}@${s.git.commit.slice(0, 7)}${s.git.dirty ? " (DIRTY)" : ""}`
        : "no-git";
    lines.push(`[validate] Saved result "${entry.name}"`);
    lines.push(`  saved at: ${s.savedAt}`);
    lines.push(`  git: ${gitLabel}`);
    if (s.projectPhCliVersion) {
        lines.push(`  project ph-cli: ${s.projectPhCliVersion}`);
    }
    if (s.phPorterVersion) {
        lines.push(`  captured by ph-porter: ${s.phPorterVersion}`);
    }
    if (s.requestedSteps) {
        lines.push(`  steps covered: ${s.requestedSteps.join(", ")}`);
    }
    lines.push(`  file: ${entry.file}`);
    lines.push("");

    for (const step of s.steps) {
        if (filter && !filter.has(step.name as ValidationStepName)) continue;
        const status = step.skipped
            ? `skipped (${step.skipReason ?? "unknown"})`
            : step.success
              ? `ok (${step.durationMs}ms)`
              : `FAILED (${step.durationMs}ms)`;
        lines.push(`--- ${step.name}: ${status} ---`);
        if (step.command) lines.push(`$ ${step.command}`);
        if (step.stdout) {
            lines.push(`[stdout]`);
            lines.push(step.stdout.replace(/\n$/, ""));
        }
        if (step.stderr) {
            lines.push(`[stderr]`);
            lines.push(step.stderr.replace(/\n$/, ""));
        }
        if (!step.stdout && !step.stderr && !step.skipped) {
            lines.push(
                step.success
                    ? "(no output captured — passing steps don't store output)"
                    : "(no output captured)",
            );
        }
        lines.push("");
    }
    return lines.join("\n");
}

export function formatResultList(entries: SavedValidationEntry[]): string {
    if (entries.length === 0) {
        return "[validate] No saved validation results yet. Use `validate --save <name>` to create one.\n";
    }
    const lines: string[] = ["[validate] Saved validation results (newest first):"];
    for (const e of entries) {
        const s = e.saved;
        const failed = s.steps
            .filter((step) => !step.skipped && !step.success)
            .map((step) => step.name);
        const status =
            failed.length === 0 ? "all ok" : `failing: ${failed.join(",")}`;
        const gitLabel = s.git
            ? `${s.git.branch}@${s.git.commit.slice(0, 7)}${s.git.dirty ? " (DIRTY)" : ""}`
            : "no-git";
        lines.push(`  - ${e.name}  (${s.savedAt}, ${gitLabel}, ${status})`);
    }
    return lines.join("\n") + "\n";
}

export function formatDiff(diff: ValidationDiff): string {
    const lines: string[] = [];
    const gitLabel = diff.againstGit
        ? ` ${diff.againstGit.branch}@${diff.againstGit.commit.slice(0, 7)}${
              diff.againstGit.dirty ? " (DIRTY)" : ""
          }`
        : "";
    const versionLabel = diff.againstProjectPhCliVersion
        ? `, project ph-cli ${diff.againstProjectPhCliVersion}`
        : "";
    lines.push(
        `[validate] Diff vs "${diff.againstName}" (saved ${diff.againstSavedAt}${gitLabel}${versionLabel}):`,
    );
    if (diff.againstGit?.dirty) {
        lines.push(
            `[validate] Warning: "${diff.againstName}" was captured with a dirty working tree — pre-existing failures may be misattributed.`,
        );
    }
    if (diff.againstRequestedSteps) {
        lines.push(
            `[validate] Note: "${diff.againstName}" only covers steps [${diff.againstRequestedSteps.join(", ")}].`,
        );
    }
    for (const d of diff.diffs) {
        const marker =
            d.category === "new-failure"
                ? "✗"
                : d.category === "fixed"
                  ? "✓"
                  : d.category === "pre-existing"
                    ? "·"
                    : d.category === "missing-in-saved"
                      ? "?"
                      : " ";
        let label: string;
        if (d.category === "new-failure") label = "NEW FAILURE";
        else if (d.category === "fixed") label = "fixed";
        else if (d.category === "pre-existing") {
            const sub =
                d.outputChange === "same"
                    ? "same output"
                    : d.outputChange === "changed"
                      ? `output changed (${d.savedOutputBytes ?? "?"}B → ${d.currentOutputBytes ?? "?"}B)`
                      : "output not comparable";
            label = `pre-existing — ${sub}`;
        } else if (d.category === "missing-in-saved")
            label = "no entry in saved result";
        else label = "unchanged";
        lines.push(`  ${marker} ${d.name}: ${label}`);
    }
    if (diff.newFailures.length === 0) {
        lines.push("[validate] No new failures vs saved.");
    } else {
        lines.push(
            `[validate] ${diff.newFailures.length} new failure(s) vs "${diff.againstName}": ${diff.newFailures
                .map((d) => d.name)
                .join(", ")}`,
        );
    }
    return lines.join("\n") + "\n";
}

export type { ValidationStepName };
