import { defineCommand } from "@powerhousedao/ph-clint";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCommand } from "package-manager-detector/commands";
import { detect } from "package-manager-detector/detect";
import type { ResolvedCommand } from "package-manager-detector";
import z from "zod";

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
    runProcess: (
        command: string,
        opts: { cwd: string; label?: string },
    ) => Promise<{ success: boolean; output: string }>;
}

async function runStep(opts: RunStepOptions): Promise<ValidationStep> {
    const { name, workdir, resolved, skipReason, stdout, runProcess } = opts;
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
    const { success } = await runProcess(command, {
        cwd: workdir,
        label: `validate:${name}`,
    });
    return {
        name,
        command,
        success,
        skipped: false,
        durationMs: Date.now() - startedAt,
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
        runProcess: (
            command: string,
            opts: { cwd: string; label?: string },
        ) => Promise<{ success: boolean; output: string }>;
        log?: { debug?: (msg: string) => void };
    },
    options?: { steps?: readonly ValidationStepName[] },
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
                runProcess: context.runProcess,
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
        const result = await runValidation(workdir, context, {
            steps: input.steps,
        });
        if (!result.success) {
            throw new Error(
                `Validation failed: ${result.failed.map((s) => s.name).join(", ")}`,
            );
        }
    },
});
