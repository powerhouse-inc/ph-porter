import { defineCommand } from "@powerhousedao/ph-clint";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { detect } from "package-manager-detector/detect";
import z from "zod";
import { CLI_NAME, CLI_VERSION } from "../config.js";
import { checkLatestVersion } from "../services/update-check.js";

const REQUIRED_SCRIPTS = ["lint:fix", "typecheck", "build"] as const;
const OPTIONAL_SCRIPTS = ["test", "lint"] as const;
const POWERHOUSE_PREFIX = "@powerhousedao/";

interface PackageJson {
    name?: string;
    version?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}

function readPackageJson(workdir: string): PackageJson | null {
    try {
        return JSON.parse(
            readFileSync(join(workdir, "package.json"), "utf8"),
        ) as PackageJson;
    } catch {
        return null;
    }
}

function listSubdirs(dir: string): string[] {
    if (!existsSync(dir)) return [];
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort();
    } catch {
        return [];
    }
}

interface GitInfo {
    isRepo: boolean;
    clean?: boolean;
    dirtyFileCount?: number;
    branch?: string;
    commit?: string;
    error?: string;
}

/**
 * Robust git probe.
 *
 * Uses `rev-parse --is-inside-work-tree` first — that's git's canonical
 * "are we in a repo?" check, and it works from any subdirectory of the repo,
 * not just the root. Status/branch/commit are gathered separately so a
 * partial failure (e.g., a repo with no commits yet) still reports
 * `isRepo: true` instead of falling through to "not a git repository".
 *
 * Distinguishes ENOENT (git missing from PATH) from a non-zero exit so we
 * don't silently report a real repo as "not git" when the binary is absent.
 */
function checkGit(workdir: string): GitInfo {
    function git(args: string[]): string {
        return execFileSync("git", args, {
            cwd: workdir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 64 * 1024 * 1024,
        }).trim();
    }

    let inside = false;
    try {
        inside = git(["rev-parse", "--is-inside-work-tree"]) === "true";
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
            return {
                isRepo: false,
                error: "git is not installed or not on PATH",
            };
        }
        return { isRepo: false };
    }
    if (!inside) return { isRepo: false };

    let status = "";
    let branch: string | undefined;
    let commit: string | undefined;
    try {
        status = git(["status", "--porcelain"]);
    } catch {
        // Tolerate; we're definitely in a repo per the rev-parse above.
    }
    try {
        branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    } catch {
        // No commits yet on this branch — leave undefined.
    }
    try {
        commit = git(["rev-parse", "--short", "HEAD"]);
    } catch {
        // No commits yet — leave undefined.
    }
    return {
        isRepo: true,
        clean: status.length === 0,
        dirtyFileCount: status.length === 0 ? 0 : status.split("\n").length,
        branch,
        commit,
    };
}

interface PowerhouseDeps {
    versions: Record<string, string>;
    coherent: boolean;
    uniqueVersions: string[];
}

function collectPowerhouseDeps(pkg: PackageJson): PowerhouseDeps {
    const versions: Record<string, string> = {};
    for (const block of [pkg.dependencies, pkg.devDependencies]) {
        if (!block) continue;
        for (const [name, version] of Object.entries(block)) {
            if (name.startsWith(POWERHOUSE_PREFIX)) versions[name] = version;
        }
    }
    const unique = [...new Set(Object.values(versions))];
    return { versions, coherent: unique.length <= 1, uniqueVersions: unique };
}

interface ModuleReport {
    name: string;
    state: "ok" | "legacy" | "mixed" | "orphan";
    note?: string;
}

/**
 * Document-model layout sniffer.
 *
 * Pre-migration projects use `document-models/<name>/<name>.json` at the root.
 * Post-migration projects move that under `v1/`. Both states present at once
 * almost always means a migration was interrupted — surface it explicitly so
 * the agent doesn't paper over it.
 */
function inspectDocumentModel(parent: string, name: string): ModuleReport {
    const root = join(parent, name);
    const hasLegacyJson = existsSync(join(root, `${name}.json`));
    const hasV1 = existsSync(join(root, "v1"));
    if (hasLegacyJson && hasV1) {
        return {
            name,
            state: "mixed",
            note: "has both `<name>.json` and `v1/` — migration may be incomplete",
        };
    }
    if (hasLegacyJson) {
        return {
            name,
            state: "legacy",
            note: "legacy unversioned layout — run `migrate` to restructure",
        };
    }
    if (hasV1) return { name, state: "ok" };
    return {
        name,
        state: "orphan",
        note: "no metadata source and no `v1/` — likely leftover from rename/delete",
    };
}

/**
 * Generic module sniffer for editors/subgraphs/processors. A module is
 * considered orphaned when none of its expected metadata files exist —
 * usually a `gen/` directory left behind after the source was renamed.
 */
function inspectModule(
    parent: string,
    name: string,
    expectedFiles: string[],
): ModuleReport {
    const root = join(parent, name);
    const hasMeta = expectedFiles.some((f) => existsSync(join(root, f)));
    if (hasMeta) return { name, state: "ok" };
    return {
        name,
        state: "orphan",
        note: `no metadata source (expected one of: ${expectedFiles.join(", ")})`,
    };
}

const inputSchema = z.object({
    workdir: z
        .string()
        .describe("The working directory of the project to inspect")
        .optional(),
});

/**
 * `status` — read-only triage.
 *
 * Reports git cleanliness, package manager, Powerhouse package version
 * coherence, presence of required scripts, and the layout of document-models /
 * editors / subgraphs / processors. Designed to be the agent's first call on
 * an unfamiliar project so it can decide between `migrate` and `validate`
 * without running anything destructive.
 */
export const statusCommand = defineCommand({
    id: "status",
    description:
        "Inspect a Reactor project (read-only): git state, package manager, Powerhouse versions, scripts, and module layout",
    inputSchema,
    async execute(input, context) {
        const workdir = input.workdir || context.workdir;
        const out = context.stdout;

        out(`[status] ${CLI_NAME} v${CLI_VERSION}\n`);
        const versionCheck = await checkLatestVersion();
        if (versionCheck.outdated && versionCheck.latest) {
            out(
                `[status] update available: ${versionCheck.current} → ${versionCheck.latest} (run \`${CLI_NAME} selfUpdate\`)${versionCheck.fromCache ? " [cached]" : ""}\n`,
            );
        } else if (versionCheck.latest) {
            out(
                `[status] up to date (latest: ${versionCheck.latest})${versionCheck.fromCache ? " [cached]" : ""}\n`,
            );
        } else if (versionCheck.error) {
            out(`[status] update check skipped: ${versionCheck.error}\n`);
        }
        // If latest is null with no error, the package isn't published yet — stay quiet.
        out(`[status] Workdir: ${workdir}\n`);

        const git = checkGit(workdir);
        out("\n[status] Git:\n");
        if (!git.isRepo) {
            if (git.error) {
                out(`  - ${git.error}\n`);
            } else {
                out("  - not a git repository (migrate refuses to run without git)\n");
            }
        } else {
            const head =
                git.branch && git.commit
                    ? `${git.branch} @ ${git.commit}`
                    : (git.branch ?? "(no commits yet)");
            out(`  - branch: ${head}\n`);
            out(
                git.clean
                    ? "  - working tree: clean\n"
                    : `  - working tree: DIRTY (${git.dirtyFileCount} file(s) — commit/stash before migrate)\n`,
            );
        }

        const detected = await detect({ cwd: workdir });
        out("\n[status] Package manager:\n");
        out(
            detected
                ? `  - detected: ${detected.agent} (via ${detected.name})\n`
                : "  - none detected — install/validate steps will be skipped\n",
        );

        const pkg = readPackageJson(workdir);
        out("\n[status] package.json:\n");
        if (!pkg) {
            out("  - missing or unparseable\n");
        } else {
            out(`  - name: ${pkg.name ?? "(unset)"}\n`);
            out(`  - version: ${pkg.version ?? "(unset)"}\n`);

            const ph = collectPowerhouseDeps(pkg);
            out("\n[status] @powerhousedao/* dependencies:\n");
            const phNames = Object.keys(ph.versions).sort();
            if (phNames.length === 0) {
                out("  - none — is this a Powerhouse project?\n");
            } else {
                for (const name of phNames) {
                    out(`  - ${name}: ${ph.versions[name]}\n`);
                }
                out(
                    ph.coherent
                        ? "  - version coherence: ok\n"
                        : `  - version coherence: MISMATCH (${ph.uniqueVersions.join(", ")}) — possible partial migration\n`,
                );
            }

            const scripts = pkg.scripts ?? {};
            out("\n[status] scripts:\n");
            for (const name of REQUIRED_SCRIPTS) {
                out(
                    name in scripts
                        ? `  - ${name}: present\n`
                        : `  - ${name}: MISSING (validate will skip this step)\n`,
                );
            }
            for (const name of OPTIONAL_SCRIPTS) {
                if (name in scripts) out(`  - ${name}: present\n`);
            }
        }

        out("\n[status] modules:\n");
        const moduleSpecs: Array<{
            label: string;
            dir: string;
            inspect: (parent: string, name: string) => ModuleReport;
        }> = [
            {
                label: "document-models",
                dir: join(workdir, "document-models"),
                inspect: inspectDocumentModel,
            },
            {
                label: "editors",
                dir: join(workdir, "editors"),
                inspect: (p, n) => inspectModule(p, n, ["module.ts", "index.ts"]),
            },
            {
                label: "subgraphs",
                dir: join(workdir, "subgraphs"),
                inspect: (p, n) => inspectModule(p, n, ["index.ts"]),
            },
            {
                label: "processors",
                dir: join(workdir, "processors"),
                inspect: (p, n) =>
                    inspectModule(p, n, ["index.ts", "module.ts", "processor.ts"]),
            },
        ];
        let anyModulesFound = false;
        for (const spec of moduleSpecs) {
            const names = listSubdirs(spec.dir);
            if (names.length === 0) continue;
            anyModulesFound = true;
            out(`  ${spec.label}/ (${names.length}):\n`);
            for (const n of names) {
                const report = spec.inspect(spec.dir, n);
                const tag =
                    report.state === "ok"
                        ? "ok"
                        : report.state === "legacy"
                          ? "LEGACY"
                          : report.state === "mixed"
                            ? "MIXED"
                            : "ORPHAN";
                out(
                    `    - ${n}: ${tag}${report.note ? ` — ${report.note}` : ""}\n`,
                );
            }
        }
        if (!anyModulesFound) {
            out("  - no module directories found\n");
        }
    },
});
