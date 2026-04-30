#!/usr/bin/env tsx
/**
 * Parse a Claude Code stream-json JSONL log into a structured summary.
 * Usable as a library (importable) or standalone (`tsx parse-migration-log.ts <file>`).
 *
 * Stream-json event shapes (as of Claude Code 1.x):
 *   { type: "system", subtype: "init", session_id, model, tools, ... }
 *   { type: "assistant", message: { content: [{ type: "text"|"tool_use", ... }] } }
 *   { type: "user",      message: { content: [{ type: "tool_result", content, is_error }] } }
 *   { type: "result",    subtype, num_turns, duration_ms, total_cost_usd, result }
 */

import { readFileSync } from 'node:fs';

export interface ToolCall {
  index: number;
  tool: string;
  input: unknown;
  output: string;
  isError: boolean;
}

export interface BashEvent {
  command: string;
  description?: string;
  output: string;
  isError: boolean;
}

export interface EditEvent {
  file: string;
  tool: 'Edit' | 'Write' | 'NotebookEdit';
}

export interface MigrationSummary {
  sessionId?: string;
  model?: string;
  numTurns?: number;
  durationMs?: number;
  costUsd?: number;
  resultText?: string;
  finalAssistantText: string;
  toolCalls: ToolCall[];
  bashEvents: BashEvent[];
  edits: EditEvent[];
  errorSignals: string[];
  rawEventCount: number;
}

const PH_PORTER_PATTERNS = [
  /\bph-porter\b/i,
  /@powerhousedao\/ph-porter/i,
];

export function parseStreamJsonl(jsonlText: string): MigrationSummary {
  const lines = jsonlText.split('\n').filter((l) => l.trim());

  const summary: MigrationSummary = {
    finalAssistantText: '',
    toolCalls: [],
    bashEvents: [],
    edits: [],
    errorSignals: [],
    rawEventCount: 0,
  };

  // Map tool_use_id -> ToolCall so we can attach the matching tool_result.
  const pendingByToolUseId = new Map<string, ToolCall>();
  let toolIndex = 0;
  let lastAssistantText = '';

  for (const line of lines) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    summary.rawEventCount++;

    if (event.type === 'system' && event.subtype === 'init') {
      summary.sessionId = event.session_id;
      summary.model = event.model;
      continue;
    }

    if (event.type === 'assistant') {
      const blocks = event.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          lastAssistantText = block.text;
        } else if (block.type === 'tool_use') {
          const call: ToolCall = {
            index: toolIndex++,
            tool: block.name,
            input: block.input,
            output: '',
            isError: false,
          };
          summary.toolCalls.push(call);
          pendingByToolUseId.set(block.id, call);
        }
      }
      continue;
    }

    if (event.type === 'user') {
      const blocks = event.message?.content ?? [];
      for (const block of blocks) {
        if (block.type !== 'tool_result') continue;
        const call = pendingByToolUseId.get(block.tool_use_id);
        if (!call) continue;
        call.output = stringifyContent(block.content);
        call.isError = block.is_error === true;
        pendingByToolUseId.delete(block.tool_use_id);
      }
      continue;
    }

    if (event.type === 'result') {
      summary.numTurns = event.num_turns;
      summary.durationMs = event.duration_ms;
      summary.costUsd = event.total_cost_usd;
      summary.resultText = typeof event.result === 'string' ? event.result : undefined;
      continue;
    }
  }

  summary.finalAssistantText = summary.resultText || lastAssistantText;

  // Extract Bash + Edit events from the tool calls.
  for (const call of summary.toolCalls) {
    if (call.tool === 'Bash') {
      const input = call.input as { command?: string; description?: string };
      summary.bashEvents.push({
        command: input.command ?? '',
        description: input.description,
        output: call.output,
        isError: call.isError,
      });
    } else if (call.tool === 'Edit' || call.tool === 'Write' || call.tool === 'NotebookEdit') {
      const input = call.input as { file_path?: string };
      if (input.file_path) {
        summary.edits.push({ file: input.file_path, tool: call.tool });
      }
    }
  }

  // Heuristic signals worth surfacing for triage.
  for (const ev of summary.bashEvents) {
    if (!ev.isError) continue;
    const isPhPorter = PH_PORTER_PATTERNS.some((p) => p.test(ev.command));
    if (isPhPorter) {
      summary.errorSignals.push(
        `ph-porter command failed: \`${truncate(ev.command, 120)}\` — ${truncate(ev.output, 200)}`,
      );
    } else {
      summary.errorSignals.push(
        `Bash failed: \`${truncate(ev.command, 120)}\` — ${truncate(ev.output, 200)}`,
      );
    }
  }
  for (const call of summary.toolCalls) {
    if (call.isError && call.tool !== 'Bash') {
      summary.errorSignals.push(`${call.tool} errored: ${truncate(call.output, 200)}`);
    }
  }

  return summary;
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content
    .map((block: any) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      return JSON.stringify(block);
    })
    .join('\n');
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}

export function summaryToMarkdown(repo: string, s: MigrationSummary, extras: {
  validateExitCode?: number;
  validateOutput?: string;
  gitDiffStat?: string;
} = {}): string {
  const lines: string[] = [];
  lines.push(`# ${repo}`);
  lines.push('');
  lines.push(`- session: \`${s.sessionId ?? '?'}\``);
  lines.push(`- model: \`${s.model ?? '?'}\``);
  lines.push(`- turns: ${s.numTurns ?? '?'} | duration: ${formatMs(s.durationMs)} | cost: ${formatCost(s.costUsd)}`);
  lines.push(`- tool calls: ${s.toolCalls.length} (bash: ${s.bashEvents.length}, edits: ${s.edits.length})`);
  if (extras.validateExitCode !== undefined) {
    lines.push(`- final \`ph-porter validate\`: ${extras.validateExitCode === 0 ? 'PASS' : `FAIL (exit ${extras.validateExitCode})`}`);
  }
  lines.push('');

  if (s.errorSignals.length) {
    lines.push('## Error signals');
    for (const sig of s.errorSignals) lines.push(`- ${sig}`);
    lines.push('');
  }

  if (s.edits.length) {
    lines.push('## Files edited by Claude');
    for (const e of s.edits) lines.push(`- \`${e.file}\` (${e.tool})`);
    lines.push('');
  }

  if (extras.gitDiffStat) {
    lines.push('## Git diff stat');
    lines.push('```');
    lines.push(extras.gitDiffStat.trim());
    lines.push('```');
    lines.push('');
  }

  if (extras.validateOutput) {
    lines.push('## Final validate output');
    lines.push('```');
    lines.push(truncate(extras.validateOutput, 4000));
    lines.push('```');
    lines.push('');
  }

  if (s.finalAssistantText) {
    lines.push("## Claude's final summary");
    lines.push(s.finalAssistantText.trim());
    lines.push('');
  }

  return lines.join('\n');
}

function formatMs(ms?: number): string {
  if (!ms && ms !== 0) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function formatCost(usd?: number): string {
  if (usd === undefined) return '?';
  return `$${usd.toFixed(4)}`;
}

// CLI entrypoint when invoked directly.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: tsx parse-migration-log.ts <stream.jsonl>');
    process.exit(2);
  }
  const text = readFileSync(file, 'utf8');
  const summary = parseStreamJsonl(text);
  console.log(summaryToMarkdown(file, summary));
}
