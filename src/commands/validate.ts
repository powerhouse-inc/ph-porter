import { defineCommand } from "@powerhousedao/ph-clint";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCommand } from "package-manager-detector/commands";
import { detect } from "package-manager-detector/detect";
import type { ResolvedCommand } from "package-manager-detector";
import z from "zod";
import {
    diffAgainst,
    formatDiff,
    formatResultList,
    formatSavedResult,
    listResults,
    readResult,
    writeResult,
} from "../services/validation-results.js";

export const VALIDATION_STEPS = [
    "lint:fix",
    "typecheck",
    "build",
    "publint",
] as const;
export type ValidationStepName = (typeof VALIDATION_STEPS)[number];

export interface ValidationStep {
    name: string;
    command?: string;
    success: boolean;
    skipped: boolean;
    skipReason?: string;
    durationMs: number;
    /**
     * Captured stdout / stderr from the step. Saved for failed steps only —
     * passing steps leave both undefined to keep saved-result files small.
     * Each stream is truncated to STEP_OUTPUT_MAX_BYTES with a trailing
     * `… (truncated …)` marker when it overflows. The streams are *not*
     * forwarded to the user's terminal during the run; if you want to read
     * them, look at the persisted validation result.
     */
    stdout?: string;
    stderr?: string;
}

const STEP_OUTPUT_MAX_BYTES = 64 * 1024;

function truncateOutput(output: string): string {
    if (output.length <= STEP_OUTPUT_MAX_BYTES) return output;
    const head = output.slice(0, STEP_OUTPUT_MAX_BYTES);
    return `${head}\n… (truncated, ${output.length - STEP_OUTPUT_MAX_BYTES} bytes omitted)\n`;
}

async function spawnAndCapture(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: { echo?: boolean },
): Promise<{ success: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(command, [...args], {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdoutBuf = "";
        let stderrBuf = "";
        child.stdout.on("data", (chunk: Buffer) => {
            stdoutBuf += chunk.toString();
            if (options?.echo) process.stdout.write(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderrBuf += chunk.toString();
            if (options?.echo) process.stderr.write(chunk);
        });
        child.on("error", (err) => {
            stderrBuf += `\n[validate] failed to spawn process: ${err.message}\n`;
            resolve({ success: false, stdout: stdoutBuf, stderr: stderrBuf });
        });
        child.on("close", (code) => {
            resolve({
                success: code === 0,
                stdout: stdoutBuf,
                stderr: stderrBuf,
            });
        });
    });
}

export interface ValidationResult {
    steps: ValidationStep[];
    failed: ValidationStep[];
    skipped: ValidationStep[];
    success: boolean;
}

function getProjectScripts(workdir: string): Record<string, string> {
    try {
        const pkg = JSON.parse(
            readFileSync(join(workdir, "package.json"), "utf8"),
        ) as { scripts?: Record<string, string> };
        return pkg.scripts ?? {};
    } catch {
        return {};
    }
}

function formatCommand(resolved: ResolvedCommand): string {
    return [resolved.command, ...resolved.args].join(" ");
}

interface RunStepOptions {
    name: string;
    workdir: string;
    resolved: ResolvedCommand | null;
    skipReason?: string;
    stdout: (msg: string) => void;
    verbose?: boolean;
}

async function runStep(opts: RunStepOptions): Promise<ValidationStep> {
    const { name, workdir, resolved, skipReason, stdout, verbose } = opts;
    if (!resolved || skipReason) {
        stdout(`\n[validate] Skipping ${name}: ${skipReason ?? "no command resolved"}\n`);
        return {
            name,
            success: true,
            skipped: true,
            skipReason: skipReason ?? "no command resolved",
            durationMs: 0,
        };
    }
    const command = formatCommand(resolved);
    stdout(`\n[validate] ${name}: ${command}\n`);
    const startedAt = Date.now();
    const { success, stdout: stdoutBuf, stderr: stderrBuf } =
        await spawnAndCapture(resolved.command, resolved.args, workdir, {
            echo: verbose,
        });
    return {
        name,
        command,
        success,
        skipped: false,
        durationMs: Date.now() - startedAt,
        stdout: success ? undefined : truncateOutput(stdoutBuf),
        stderr: success ? undefined : truncateOutput(stderrBuf),
    };
}

/**
 * Runs the standard post-migration validation suite against `workdir`:
 *   1. `lint:fix` script (eslint --fix)
 *   2. `typecheck` script (tsc --noEmit)
 *   3. `build` script
 *   4. `publint` (executed via the project's package manager dlx/exec)
 *
 * Each step is optional: if the script is missing from package.json or no
 * package manager can be detected, the step is recorded as skipped instead
 * of failing the whole run. The function never throws on step failure — it
 * returns a structured `ValidationResult` so the caller (migrate or the
 * standalone command) can decide how to surface issues to the agent/user.
 */
export async function runValidation(
    workdir: string,
    context: {
        stdout: (msg: string) => void;
        log?: { debug?: (msg: string) => void };
    },
    options?: {
        steps?: readonly ValidationStepName[];
        verbose?: boolean;
    },
): Promise<ValidationResult> {
    const detected = await detect({ cwd: workdir });
    if (!detected) {
        context.stdout(
            `[validate] Could not detect a package manager in ${workdir}. Skipping validation.\n`,
        );
        const skipped: ValidationStep = {
            name: "detect-package-manager",
            success: true,
            skipped: true,
            skipReason: "no package manager detected",
            durationMs: 0,
        };
        return { steps: [skipped], failed: [], skipped: [skipped], success: true };
    }

    const scripts = getProjectScripts(workdir);
    const requested = options?.steps ? new Set(options.steps) : null;
    const stepsConfig: Array<{
        name: ValidationStepName;
        type: "run" | "execute" | "execute-local";
        args: string[];
        skipReason?: string;
    }> = [
        {
            name: "lint:fix",
            type: "run",
            args: ["lint:fix"],
            skipReason: scripts["lint:fix"]
                ? undefined
                : "missing `lint:fix` script in package.json",
        },
        // Migrated projects don't ship a `typecheck` script — invoke the
        // locally-installed `tsc` directly via the package manager's exec.
        {
            name: "typecheck",
            type: "execute-local",
            args: ["tsc", "--noEmit"],
        },
        {
            name: "build",
            type: "run",
            args: ["build"],
            skipReason: scripts.build
                ? undefined
                : "missing `build` script in package.json",
        },
        // publint is not a project dep — use `execute` so the PM can dlx it.
        { name: "publint", type: "execute", args: ["publint"] },
    ];

    const steps: ValidationStep[] = [];
    for (const cfg of stepsConfig) {
        if (requested && !requested.has(cfg.name)) continue;
        const resolved = cfg.skipReason
            ? null
            : resolveCommand(detected.agent, cfg.type, cfg.args);
        steps.push(
            await runStep({
                name: cfg.name,
                workdir,
                resolved,
                skipReason: cfg.skipReason,
                stdout: context.stdout,
                verbose: options?.verbose,
            }),
        );
    }

    const failed = steps.filter((s) => !s.skipped && !s.success);
    const skipped = steps.filter((s) => s.skipped);

    context.stdout("\n[validate] Summary:\n");
    for (const step of steps) {
        const status = step.skipped
            ? `skipped (${step.skipReason ?? "unknown"})`
            : step.success
              ? `ok (${step.durationMs}ms)`
              : `FAILED (${step.durationMs}ms)`;
        context.stdout(`  - ${step.name}: ${status}\n`);
    }
    if (failed.length > 0) {
        context.stdout(
            `\n[validate] ${failed.length} step(s) failed: ${failed.map((s) => s.name).join(", ")}. Review the output above.\n`,
        );
    } else {
        context.stdout("\n[validate] All checks passed.\n");
    }

    return { steps, failed, skipped, success: failed.length === 0 };
}

const inputSchema = z.object({
    workdir: z
        .string()
        .describe("The working directory of the project to validate")
        .optional(),
    steps: z
        .array(z.enum(VALIDATION_STEPS))
        .nonempty()
        .describe(
            `Subset of validation steps to run. Defaults to all: ${VALIDATION_STEPS.join(", ")}.`,
        )
        .optional(),
    save: z
        .string()
        .describe(
            "Save the validation result under .ph/ph-porter/results/<name>.json so a later --diff can compare against it.",
        )
        .optional(),
    diff: z
        .string()
        .describe(
            "Compare the validation result against a previously saved result with the given name.",
        )
        .optional(),
    list: z
        .boolean()
        .describe(
            "List all saved validation results for this project (newest first) with their metadata.",
        )
        .optional(),
    show: z
        .string()
        .describe(
            "Print a previously saved validation result by name — metadata plus each step's captured stdout/stderr. Combine with --steps to filter to specific steps.",
        )
        .optional(),
    verbose: z
        .boolean()
        .describe(
            "Stream each step's stdout and stderr to the terminal as the step runs. Off by default — captured output is still captured in the saved validation result regardless.",
        )
        .optional(),
});

/**
 * Standalone `validate` command. Mirrors the post-migrate hook so agents can
 * re-run the suite on demand without re-running the destructive migration.
 */
export const validateCommand = defineCommand({
    id: "validate",
    description:
        "Run lint:fix, typecheck, build, and publint against a Reactor project to surface migration issues",
    inputSchema,
    async execute(input, context) {
        const workdir = input.workdir || context.workdir;

        if (input.list) {
            context.stdout(formatResultList(listResults(workdir)));
            return;
        }

        if (input.show) {
            const entry = readResult(workdir, input.show);
            if (!entry) {
                throw new Error(
                    `No saved result named "${input.show}" under .ph/ph-porter/results/. Use --list to see available names.`,
                );
            }
            context.stdout(formatSavedResult(entry, { steps: input.steps }));
            return;
        }

        const result = await runValidation(workdir, context, {
            steps: input.steps,
            verbose: input.verbose,
        });

        if (input.save) {
            const { name, file } = writeResult(workdir, input.save, result, {
                requestedSteps: input.steps,
            });
            context.stdout(
                `[validate] Saved validation result "${name}" to ${file}\n`,
            );
        }

        if (input.diff) {
            const entry = readResult(workdir, input.diff);
            if (!entry) {
                context.stdout(
                    `[validate] --diff: no saved result named "${input.diff}" under .ph/ph-porter/results/. Run with --save first, or check available names with --list.\n`,
                );
                if (!result.success) {
                    throw new Error(
                        `Validation failed: ${result.failed.map((s) => s.name).join(", ")}`,
                    );
                }
                return;
            }
            const diff = diffAgainst(entry, result);
            context.stdout("\n" + formatDiff(diff));
            if (diff.newFailures.length > 0) {
                throw new Error(
                    `Validation failed (vs "${entry.name}"): ${diff.newFailures.map((d) => d.name).join(", ")}`,
                );
            }
            return;
        }

        if (!result.success) {
            throw new Error(
                `Validation failed: ${result.failed.map((s) => s.name).join(", ")}`,
            );
        }
    },
});
