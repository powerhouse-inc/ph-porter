#!/usr/bin/env tsx
/**
 * Batch-migrate Powerhouse Reactor projects via Claude Code headless mode,
 * driving the `ph-porter` skill, and capture per-repo logs + an aggregate report.
 *
 * Usage:
 *   pnpm tsx scripts/batch-migrate.ts <repos-file> [--workspace DIR] [--logs DIR]
 *                                      [--target VERSION] [--concurrency N]
 *                                      [--keep-clones]
 *
 * <repos-file> format: one git URL or `org/repo` per line. `#` for comments.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, rm, stat } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseStreamJsonl, summaryToMarkdown, type MigrationSummary } from './parse-migration-log.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const SKILL_SRC = path.join(PROJECT_ROOT, 'ph-porter', 'SKILL.md');
const USER_SKILL_DIR = path.join(os.homedir(), '.claude', 'skills', 'ph-porter');

interface CliArgs {
  reposFile: string;
  workspace: string;
  logs: string;
  target: string;
  concurrency: number;
  keepClones: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace') args.workspace = argv[++i];
    else if (a === '--logs') args.logs = argv[++i];
    else if (a === '--target') args.target = argv[++i];
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (a === '--keep-clones') args.keepClones = true;
    else if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    else positional.push(a);
  }
  if (!positional[0]) {
    console.error('Usage: tsx scripts/batch-migrate.ts <repos-file> [options]');
    process.exit(2);
  }
  return {
    reposFile: positional[0],
    // Workspace lives outside the repo so cloned projects don't inherit
    // ph-porter's pnpm-workspace.yaml during install.
    workspace: args.workspace ?? path.join(os.homedir(), '.cache', 'ph-porter-batch', 'workspace'),
    logs: args.logs ?? path.join(PROJECT_ROOT, 'batch-migrate-logs'),
    target: args.target ?? 'staging',
    concurrency: args.concurrency ?? 1,
    keepClones: args.keepClones ?? false,
  };
}

interface RepoEntry {
  raw: string;
  url: string;
  name: string;
  /** Branch to check out. If undefined, auto-detect the most recently changed branch. */
  branch?: string;
}

async function readRepos(file: string): Promise<RepoEntry[]> {
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map((raw): RepoEntry => {
      // Accept GitHub /tree/<branch> URLs and `org/repo@branch` shorthand.
      let working = raw;
      let branch: string | undefined;
      const treeMatch = working.match(/^(https?:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/([^/]+)\/?$/);
      if (treeMatch) {
        working = treeMatch[1];
        branch = treeMatch[2];
      }
      const atMatch = working.match(/^([^@]+)@([^@]+)$/);
      if (!treeMatch && atMatch && !working.startsWith('git@')) {
        working = atMatch[1];
        branch = atMatch[2];
      }
      const url = working.includes('://') || working.startsWith('git@')
        ? (working.endsWith('.git') ? working : `${working}.git`)
        : `https://github.com/${working}.git`;
      const name = (working.match(/([^/:]+?)(?:\.git)?$/)?.[1] ?? working).replace(/[^\w.-]/g, '_');
      return { raw, url, name, branch };
    });
}

interface RepoResult {
  repo: RepoEntry;
  status: 'success' | 'validate-failed' | 'claude-error' | 'clone-error' | 'skipped';
  validateExitCode?: number;
  claudeExitCode?: number;
  durationMs: number;
  summary?: MigrationSummary;
  errorMessage?: string;
}

function buildPrompt(target: string): string {
  return [
    `You are migrating this Powerhouse Reactor project to the \`${target}\` Powerhouse stack version (a published dist-tag or semver, passed verbatim to ph-porter's --version flag).`,
    'The `ph-porter` skill is loaded — use it.',
    `Run \`ph-porter migrate --version ${target}\` and then iterate on \`ph-porter validate\` until it is green or the remaining issues genuinely require human input.`,
    'Do not ask the user questions — make reasonable choices and proceed. Never bypass the clean-tree check; if the tree is dirty, stop and report.',
    'When you are done, output a short markdown summary covering: what changed, which validate steps remain failing (if any), and any upstream/CLI issues you noticed.',
  ].join(' ');
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(SKILL_SRC)) {
    console.error(`Cannot find skill source at ${SKILL_SRC}`);
    process.exit(1);
  }
  if (!hasOnPath('claude')) {
    console.error('`claude` CLI not found on PATH. Install Claude Code first.');
    process.exit(1);
  }

  const repos = await readRepos(args.reposFile);
  if (repos.length === 0) {
    console.error(`No repos found in ${args.reposFile}`);
    process.exit(1);
  }

  await mkdir(args.workspace, { recursive: true });
  await mkdir(args.logs, { recursive: true });

  // Install the ph-porter skill at the user level so every spawned `claude`
  // auto-loads it without us having to dirty each cloned repo.
  await mkdir(USER_SKILL_DIR, { recursive: true });
  await cp(SKILL_SRC, path.join(USER_SKILL_DIR, 'SKILL.md'));
  console.log(`[batch-migrate] installed skill at ${USER_SKILL_DIR}`);

  console.log(`[batch-migrate] ${repos.length} repos | workspace=${args.workspace} | logs=${args.logs}`);

  const results: RepoResult[] = [];
  const queue = [...repos];
  const workers = Array.from({ length: Math.max(1, args.concurrency) }, async () => {
    while (queue.length) {
      const repo = queue.shift();
      if (!repo) break;
      const result = await runOne(repo, args);
      results.push(result);
      console.log(`[${repo.name}] ${result.status} (${Math.round(result.durationMs / 1000)}s)`);
    }
  });
  await Promise.all(workers);

  results.sort((a, b) => a.repo.name.localeCompare(b.repo.name));
  await writeAggregateReport(results, args.logs);
  console.log(`[batch-migrate] done. Aggregate report: ${path.join(args.logs, 'report.md')}`);
}

async function runOne(repo: RepoEntry, args: CliArgs): Promise<RepoResult> {
  const started = Date.now();
  const repoDir = path.join(args.workspace, repo.name);
  const repoLogs = path.join(args.logs, repo.name);
  await mkdir(repoLogs, { recursive: true });

  // Fresh clone: blow away any stale workspace dir from a prior run.
  if (existsSync(repoDir)) {
    await rm(repoDir, { recursive: true, force: true });
  }

  // Full clone (all branches) so we can pick the most recently changed branch.
  const cloneResult = await spawnCapture('git', ['clone', repo.url, repoDir], {
    logFile: path.join(repoLogs, 'clone.log'),
  });
  if (cloneResult.exitCode !== 0) {
    return {
      repo,
      status: 'clone-error',
      durationMs: Date.now() - started,
      errorMessage: `git clone exited ${cloneResult.exitCode}`,
    };
  }

  const branch = repo.branch ?? (await detectMostRecentBranch(repoDir));
  if (branch) {
    const checkout = await spawnCapture('git', ['checkout', branch], {
      cwd: repoDir,
      logFile: path.join(repoLogs, 'checkout.log'),
    });
    if (checkout.exitCode !== 0) {
      return {
        repo,
        status: 'clone-error',
        durationMs: Date.now() - started,
        errorMessage: `git checkout ${branch} exited ${checkout.exitCode}`,
      };
    }
    await writeFile(path.join(repoLogs, 'branch.txt'), branch + '\n');
  }

  // Run claude headless. Skill is loaded user-level (~/.claude/skills/ph-porter/),
  // so the cloned repo stays pristine — no .claude/ injection, no clean-tree workaround.
  // Stream-json + verbose so we capture every event.
  const streamFile = path.join(repoLogs, 'stream.jsonl');
  const stderrFile = path.join(repoLogs, 'stderr.log');
  const claudeResult = await spawnCapture(
    'claude',
    [
      '-p', buildPrompt(args.target),
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ],
    { cwd: repoDir, stdoutFile: streamFile, stderrFile },
  );

  // Run validate ourselves as ground-truth, regardless of what Claude reported.
  const validateResult = await spawnCapture(
    'pnpm',
    ['dlx', '@powerhousedao/ph-porter@latest', 'validate'],
    { cwd: repoDir, logFile: path.join(repoLogs, 'validate.log') },
  );

  // Capture diff between the pristine clone and Claude's edits.
  await spawnCapture('git', ['add', '-A'], { cwd: repoDir });
  const diffResult = await spawnCapture(
    'git',
    ['diff', '--cached', '--stat'],
    { cwd: repoDir, logFile: path.join(repoLogs, 'git-diff.stat') },
  );
  await spawnCapture('git', ['diff', '--cached'], {
    cwd: repoDir,
    logFile: path.join(repoLogs, 'git-diff.patch'),
  });

  // Parse the JSONL stream into a structured summary.
  let summary: MigrationSummary | undefined;
  try {
    const jsonl = await readFile(streamFile, 'utf8');
    summary = parseStreamJsonl(jsonl);
  } catch (err) {
    console.error(`[${repo.name}] failed to parse stream.jsonl:`, err);
  }

  const repoReport = summaryToMarkdown(repo.name, summary ?? emptySummary(), {
    validateExitCode: validateResult.exitCode,
    validateOutput: await safeRead(path.join(repoLogs, 'validate.log')),
    gitDiffStat: await safeRead(path.join(repoLogs, 'git-diff.stat')),
  });
  await writeFile(path.join(repoLogs, 'report.md'), repoReport);
  await writeFile(path.join(repoLogs, 'summary.json'), JSON.stringify({
    repo: repo.raw,
    claudeExitCode: claudeResult.exitCode,
    validateExitCode: validateResult.exitCode,
    summary,
  }, null, 2));

  if (!args.keepClones) {
    await rm(repoDir, { recursive: true, force: true });
  }

  let status: RepoResult['status'];
  if (claudeResult.exitCode !== 0) status = 'claude-error';
  else if (validateResult.exitCode !== 0) status = 'validate-failed';
  else status = 'success';

  return {
    repo,
    status,
    claudeExitCode: claudeResult.exitCode,
    validateExitCode: validateResult.exitCode,
    durationMs: Date.now() - started,
    summary,
  };
}

async function writeAggregateReport(results: RepoResult[], logsDir: string): Promise<void> {
  const lines: string[] = [];
  lines.push('# Batch migration report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  const counts = countBy(results, (r) => r.status);
  lines.push('## Outcomes');
  for (const [status, n] of Object.entries(counts)) {
    lines.push(`- ${status}: ${n}`);
  }
  lines.push('');

  lines.push('## Per-repo');
  lines.push('');
  lines.push('| Repo | Status | Validate | Turns | Cost | Duration |');
  lines.push('|------|--------|----------|-------|------|----------|');
  for (const r of results) {
    const turns = r.summary?.numTurns ?? '?';
    const cost = r.summary?.costUsd !== undefined ? `$${r.summary.costUsd.toFixed(3)}` : '?';
    const dur = `${Math.round(r.durationMs / 1000)}s`;
    const validate = r.validateExitCode === 0 ? 'pass' : r.validateExitCode === undefined ? '?' : `fail(${r.validateExitCode})`;
    lines.push(`| ${r.repo.name} | ${r.status} | ${validate} | ${turns} | ${cost} | ${dur} |`);
  }
  lines.push('');

  // Aggregated error signals — the most useful section for spotting patterns.
  lines.push('## Error signals (across all repos)');
  lines.push('');
  for (const r of results) {
    if (!r.summary?.errorSignals?.length) continue;
    lines.push(`### ${r.repo.name}`);
    for (const sig of r.summary.errorSignals) lines.push(`- ${sig}`);
    lines.push('');
  }

  await writeFile(path.join(logsDir, 'report.md'), lines.join('\n'));
}

async function detectMostRecentBranch(repoDir: string): Promise<string | undefined> {
  const out = await spawnGetStdout(
    'git',
    ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes/origin/'],
    { cwd: repoDir },
  );
  const branches = out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((ref) => ref !== 'origin/HEAD' && !ref.startsWith('origin/HEAD '))
    .map((ref) => ref.replace(/^origin\//, ''));
  return branches[0];
}

async function spawnGetStdout(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => (buf += d.toString()));
    child.stderr.resume();
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(buf));
  });
}

function emptySummary(): MigrationSummary {
  return {
    finalAssistantText: '',
    toolCalls: [],
    bashEvents: [],
    edits: [],
    errorSignals: [],
    rawEventCount: 0,
  };
}

interface SpawnOptions {
  cwd?: string;
  logFile?: string;
  stdoutFile?: string;
  stderrFile?: string;
}

async function spawnCapture(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    const stdoutPath = opts.stdoutFile ?? opts.logFile;
    const stderrPath = opts.stderrFile ?? opts.logFile;

    if (stdoutPath) {
      const out = createWriteStream(stdoutPath, { flags: stdoutPath === stderrPath ? 'a' : 'w' });
      child.stdout.pipe(out);
    } else {
      child.stdout.resume();
    }
    if (stderrPath) {
      const err = createWriteStream(stderrPath, { flags: stdoutPath === stderrPath ? 'a' : 'w' });
      child.stderr.pipe(err);
    } else {
      child.stderr.resume();
    }

    child.on('error', () => resolve({ exitCode: 1 }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1 }));
  });
}

function hasOnPath(cmd: string): boolean {
  const PATH = process.env.PATH ?? '';
  for (const dir of PATH.split(path.delimiter)) {
    const p = path.join(dir, cmd);
    try {
      if (existsSync(p)) return true;
    } catch {}
  }
  return false;
}

async function safeRead(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

run().catch((err) => {
  console.error('[batch-migrate] fatal:', err);
  process.exit(1);
});
