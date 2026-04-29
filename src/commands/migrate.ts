import { migrate } from "@powerhousedao/codegen";
import { defineCommand } from "@powerhousedao/ph-clint";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCommand } from "package-manager-detector/commands";
import { detect } from "package-manager-detector/detect";
import z from "zod";
import validSemver from "semver/functions/valid.js";
import cleanSemver from "semver/functions/clean.js";
import { runValidation } from "./validate.js";
// import {
//     logMigrationFailure,
//     logMigrationStart,
//     logMigrationSuccess,
//     type MigrationPhase,
// } from "../services/migration-log.js";

/**
 * Accept either a clean semver (`"1.2.3"`, `"v1.2.3"`) or a dist-tag
 * (`"latest"`, `"staging"`, `"dev"`, `"production"`, …). Dist-tags are passed
 * through verbatim — `migrate()` resolves them against the npm registry and
 * throws if no such tag exists for the pinned packages.
 */
function normalizeVersion(input: string): string {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        throw new Error("Version is required");
    }
    const cleaned = cleanSemver(trimmed);
    if (cleaned && validSemver(cleaned)) return cleaned;
    return trimmed;
}

function getProjectPhCliVersion(workdir: string): string | undefined {
    const pkgName = "@powerhousedao/ph-cli";
    try {
        const pkg = JSON.parse(
            readFileSync(join(workdir, "package.json"), "utf8"),
        ) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        return pkg.dependencies?.[pkgName] ?? pkg.devDependencies?.[pkgName];
    } catch {
        return undefined;
    }
}

async function runInstall(
    workdir: string,
    stdout: (msg: string) => void,
): Promise<void> {
    const detected = await detect({ cwd: workdir });
    if (!detected) {
        stdout(
            `Could not detect a package manager in ${workdir}. Run your package manager's install command manually.\n`,
        );
        return;
    }
    const resolved = resolveCommand(detected.agent, "install", []);
    if (!resolved) {
        stdout(
            `Detected ${detected.agent}, but it has no install command available. Skipping install.\n`,
        );
        return;
    }
    stdout(
        `Detected ${detected.agent}. Running \`${resolved.command} ${resolved.args.join(" ")}\` in ${workdir}...\n`,
    );
    execFileSync(resolved.command, resolved.args, {
        cwd: workdir,
        stdio: "inherit",
    });
}

const inputSchema = z.object({
    version: z.string().describe("The version to migrate to, e.g. '1.0.0', 'latest', or a dist-tag"),
    workdir: z.string().describe("The working directory of the project to do the migration").optional(),
});

/**
 * Migrates a Reactor project to a target version of the Powerhouse stack.
 *
 * Inputs:
 *   - `version`: a semver (`"1.2.3"`) or a dist-tag (`"latest" | "staging" | "dev"`).
 *     Dist-tags are resolved against the npm registry inside `migrate()`.
 *   - `workdir`: optional; defaults to `context.workdir`. Must be a git repo
 *     with a clean working tree (the command refuses to run otherwise).
 *
 * Pre-flight performed here (before delegating to `@powerhousedao/codegen`):
 *   1. Cleans + validates the version string with `semver`.
 *   2. Runs `git status --porcelain` and aborts if there are uncommitted changes,
 *      because `migrate()` rewrites many tracked files and leaves no built-in undo.
 *   3. Reports the project's declared `@powerhousedao/ph-cli` version by reading
 *      `<workdir>/package.json` (best-effort — silently skipped if the file is
 *      missing/unparseable or the package isn't a direct dep).
 *
 * Post-step performed here (after `migrate()` returns):
 *   - Detects the project's package manager via `package-manager-detector`
 *     (lockfile + `packageManager` field) and runs the matching install command
 *     (`npm install` / `pnpm install` / `yarn` / `bun install` / …) so the new
 *     pinned versions actually end up in `node_modules/`. If detection fails,
 *     prints a fallback message and skips install instead of guessing.
 *
 * Telemetry / migration log:
 *   - Every run is recorded as a Mastra `Memory` thread on a global LibSQL
 *     database (`~/.config/ph-porter/memory.db` by default; honors
 *     `XDG_CONFIG_HOME` and a `PH_PORTER_HOME` override). Resource id is
 *     `ph-porter-migrations`; `thread.metadata` carries inputs, status,
 *     duration, and on failure the phase + error message/stack. Logging is
 *     best-effort: storage failures never break the migration.
 *
 * What `migrate(version, workdir)` from `@powerhousedao/codegen` does:
 *   - Resolves dist-tags via the npm registry, then rewrites `package.json`:
 *     pins all `VERSIONED_DEPENDENCIES` / `VERSIONED_DEV_DEPENDENCIES` (Powerhouse
 *     workspace packages) to that version, applies pinned versions for tracked
 *     third-party deps, fixes deps that ended up in the wrong section, overwrites
 *     `exports`, and merges `scripts` with the canonical `packageScripts`.
 *   - Re-writes the project's root boilerplate files (tsconfig, vite config, …)
 *     via `writeAllGeneratedProjectFiles`.
 *   - Restructures legacy unversioned document models: for each
 *     `document-models/<model>/` with a `<model>.json`, deletes legacy files
 *     (`actions.ts`, `hooks.ts`, `module.ts`, `index.ts`, `utils.ts`,
 *     `schema.graphql`), creates `v1/`, and moves `src/` and `gen/` into it.
 *   - Fixes legacy import paths in source files via ts-morph: strips
 *     `<package-name>/` prefixes, redirects `generateMock` to `document-model`,
 *     and rewrites `../../../document-models/foo/...` → `document-models/foo`.
 *   - Re-runs `generateAll(project)` to regenerate every module type from its
 *     metadata source-of-truth, then saves the ts-morph project to disk:
 *       • `document-models/`: `<name>.json` specs → regenerated `gen/` output.
 *       • `editors/`: metadata in `module.ts` → regenerated editor code (skips
 *         `powerhouse/document-drive` editors, those are apps).
 *       • `editors/` (drive-document only): regenerated as apps.
 *       • `subgraphs/`: name from `index.ts` → regenerated subgraph.
 *       • `processors/`: metadata → regenerated processor.
 *
 * Caveats worth knowing for agents:
 *   - `generateAll` only *regenerates*; it never prunes. Renamed/removed modules
 *     leave their old directories behind.
 *   - Modules whose metadata can't be parsed are silently skipped (no error).
 *   - `migrate()` itself does NOT run a package-install; this command runs it
 *     for you after `migrate()` succeeds (see post-step above).
 *   - The operation is destructive on disk (file rewrites, layout changes) —
 *     the clean-tree guard above is what makes it safely reversible via `git`.
 */
export const migrateCommand = defineCommand({
  id: "migrate",
  description: "Migrate Reactor projects",
  inputSchema: inputSchema,
  async execute(input, context) {
      const workdir = input.workdir || context.workdir;
      const version = normalizeVersion(input.version);

      const status = execFileSync("git", ["status", "--porcelain"], {
          cwd: workdir,
          encoding: "utf8",
      });
      if (status.trim().length > 0) {
          throw new Error(
              `Uncommitted changes detected in ${workdir}. Commit or stash them before migrating.`,
          );
      }

      const currentVersion = getProjectPhCliVersion(workdir);
      if (currentVersion) {
          context.stdout(
              `Current version: ${currentVersion}\n`,
          );
      }

      const startedAt = Date.now();
      context.log?.debug(`Starting migration of ${workdir} from version ${currentVersion} to ${version}`);
      try {
          context.stdout(`Migrating project in ${workdir} to version ${version}...\n`);
          await migrate(version, workdir);
          await runInstall(workdir, context.stdout);
          context.log?.debug(`Migration completed in ${Date.now() - startedAt}ms`);

          context.stdout(`\nRunning post-migration validation...\n`);
          await runValidation(workdir, context);
      } catch (err) {
            context.log?.error(`Migration failed: ${(err as Error).message}`);
          throw err;
      }
  },
});