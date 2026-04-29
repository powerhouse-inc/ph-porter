#!/usr/bin/env tsx
/**
 * Build script — compiles Handlebars templates in `prompts/` into static
 * SKILL.md files and agent instruction strings under `gen/`, using
 * ph-clint-dev's `buildSkills`.
 */
import path from 'node:path';
import { buildSkills } from '@powerhousedao/ph-clint-dev';
import { cli } from '../src/cli.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

// @clint:begin templateVars
function loadTemplateVars(): Record<string, string> {
  return {
    agentName: '{{AGENT_NAME}}',
  };
}
// @clint:end templateVars

buildSkills({
  include: [path.join(PROJECT_ROOT, 'prompts')],
  context: loadTemplateVars(),
  output: [
    path.join(PROJECT_ROOT, 'gen'),
    path.join(PROJECT_ROOT, 'dist', 'gen'),
  ],
  cli,
});
