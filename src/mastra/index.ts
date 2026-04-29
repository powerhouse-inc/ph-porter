// @clint:begin mastra-index
/**
 * Mastra Studio entry point for `mastra dev` / `mastra build` / `mastra start`.
 *
 * Bootstraps the CLI to get the configured agent, then exports a Mastra
 * instance for Studio integration.
 */
import { Mastra } from '@mastra/core/mastra';
import type { Agent } from '@mastra/core/agent';
import path from 'node:path';
import { cli } from '../cli.js';
import { CLI_ROOT } from '../config.js';

// Under `mastra dev`, CLI_ROOT points to .mastra/ (bundler output).
// The actual project root is its parent.
const projectRoot = path.basename(CLI_ROOT) === '.mastra'
  ? path.dirname(CLI_ROOT)
  : CLI_ROOT;

const rt = await cli.bootstrap({ workdir: projectRoot });

// Workaround: Mastra Studio checks process.env for API keys directly.
// Bridge the ph-clint resolved keys so Studio's provider detection works.
{
  const key = rt.config.anthropicApiKey as string | undefined;
  if (key && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = key;
}

const mastraAgent = await rt.mastraAgent as Agent | undefined;

export const mastra = new Mastra({
  agents: mastraAgent ? { [mastraAgent.id]: mastraAgent } : {},
});
// @clint:end mastra-index
