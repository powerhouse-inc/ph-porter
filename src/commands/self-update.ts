import { defineCommand } from "@powerhousedao/ph-clint";
import { execFileSync } from "node:child_process";
import { CLI_NAME, CLI_VERSION } from "../config.js";
import {
    checkLatestVersion,
    clearVersionCache,
} from "../services/update-check.js";
import z from "zod";

type InstallManager = "npm" | "pnpm" | "yarn" | "bun" | "npx" | "unknown";

interface InstallInfo {
    manager: InstallManager;
    path: string;
}

/**
 * Heuristic: figure out which package manager owns the running ph-porter
 * binary by inspecting `process.argv[1]`. We don't trust this for anything
 * destructive — a wrong guess just means the user gets an instruction line
 * instead of an attempted update.
 *
 * - `_npx` / `dlx` style cache paths → npx (don't try to update; they get
 *   latest by re-invoking with `@latest`).
 * - `.bun` in path → bun global install.
 * - `pnpm` in path → pnpm global install.
 * - yarn global path patterns → yarn classic global.
 * - generic global `node_modules` → npm.
 */
function detectInstallMethod(): InstallInfo {
    const exec = process.argv[1] ?? "";
    const lower = exec.toLowerCase();

    if (
        lower.includes("/_npx/") ||
        lower.includes("/.npm/_npx/") ||
        lower.includes("/dlx-")
    ) {
        return { manager: "npx", path: exec };
    }
    if (lower.includes("/.bun/") || lower.includes("/bun/install/")) {
        return { manager: "bun", path: exec };
    }
    if (lower.includes("/pnpm/") || lower.includes("/.pnpm/")) {
        return { manager: "pnpm", path: exec };
    }
    if (
        lower.includes("/.config/yarn/global/") ||
        lower.includes("/yarn/global/")
    ) {
        return { manager: "yarn", path: exec };
    }
    if (
        lower.includes("/lib/node_modules/") ||
        lower.includes("/node_modules/.bin/")
    ) {
        return { manager: "npm", path: exec };
    }
    return { manager: "unknown", path: exec };
}

function buildUpdateCommand(
    manager: InstallManager,
    version: string,
): { command: string; args: string[] } | null {
    const target = `${CLI_NAME}@${version}`;
    switch (manager) {
        case "npm":
            return { command: "npm", args: ["install", "-g", target] };
        case "pnpm":
            return { command: "pnpm", args: ["add", "-g", target] };
        case "yarn":
            return { command: "yarn", args: ["global", "add", target] };
        case "bun":
            return { command: "bun", args: ["install", "-g", target] };
        default:
            return null;
    }
}

const inputSchema = z.object({
    version: z
        .string()
        .describe(
            "Target version to install. Defaults to the dist-tag specified by --tag (default: latest).",
        )
        .optional(),
    tag: z
        .string()
        .describe("npm dist-tag to compare against. Default: latest.")
        .optional(),
    check: z
        .boolean()
        .describe("Only report whether an update is available; do not install.")
        .optional(),
    force: z
        .boolean()
        .describe(
            "Reinstall even when the current version already matches the target.",
        )
        .optional(),
});

/**
 * `selfUpdate` — keep the installed ph-porter binary in sync with what's
 * published on npm. Always queries the registry fresh (bypasses the `status`
 * cache), compares against the running version, and either reports the gap
 * (`--check`) or invokes the matching global-install command.
 *
 * Refuses to run an install when invoked via `npx` / `pnpm dlx`, since those
 * already resolve `@latest` per invocation — the user just needs to re-run
 * with `@latest` (or no version pin).
 */
export const selfUpdateCommand = defineCommand({
    id: "selfUpdate",
    description:
        "Check for and install a newer version of the ph-porter CLI from npm",
    inputSchema,
    async execute(input, context) {
        const out = context.stdout;
        const tag = input.tag ?? "latest";

        let target = input.version;
        if (!target) {
            const result = await checkLatestVersion({ force: true, distTag: tag });
            if (result.error || !result.latest) {
                throw new Error(
                    `Could not resolve ${CLI_NAME}@${tag} from npm: ${result.error ?? "no version returned"}`,
                );
            }
            target = result.latest;
        }

        out(`[self-update] current: ${CLI_VERSION}\n`);
        out(`[self-update] target:  ${target} (${tag})\n`);

        if (!input.force && target === CLI_VERSION) {
            out(`[self-update] already on ${CLI_VERSION}; nothing to do.\n`);
            return;
        }

        if (input.check) {
            out(
                target !== CLI_VERSION
                    ? `[self-update] update available: ${CLI_VERSION} → ${target}\n`
                    : `[self-update] up to date.\n`,
            );
            return;
        }

        const install = detectInstallMethod();
        out(
            `[self-update] detected install: ${install.manager}${install.path ? ` (${install.path})` : ""}\n`,
        );

        if (install.manager === "npx") {
            out(
                `[self-update] ph-porter is running via npx/dlx — re-invoke as \`npx ${CLI_NAME}@${tag}\` (or \`pnpm dlx ${CLI_NAME}@${tag}\`) to pick up the new version.\n`,
            );
            return;
        }

        const cmd = buildUpdateCommand(install.manager, target);
        if (!cmd) {
            out(
                `[self-update] could not detect a global package manager for the running binary.\n`,
            );
            out(`[self-update] run one of the following manually:\n`);
            out(`  npm install -g ${CLI_NAME}@${target}\n`);
            out(`  pnpm add -g ${CLI_NAME}@${target}\n`);
            out(`  yarn global add ${CLI_NAME}@${target}\n`);
            out(`  bun install -g ${CLI_NAME}@${target}\n`);
            return;
        }

        out(`[self-update] running: ${cmd.command} ${cmd.args.join(" ")}\n`);
        try {
            execFileSync(cmd.command, cmd.args, { stdio: "inherit" });
        } catch (err) {
            throw new Error(
                `Update via \`${cmd.command} ${cmd.args.join(" ")}\` failed: ${(err as Error).message}`,
            );
        }

        clearVersionCache();
        out(
            `[self-update] installed ${CLI_NAME}@${target}. Re-run your command to use the new version.\n`,
        );
    },
});
