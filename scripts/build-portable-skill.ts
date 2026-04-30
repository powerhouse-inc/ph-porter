#!/usr/bin/env tsx
/**
 * Builds the portable Anthropic skill at `<bin-name>/SKILL.md`.
 *
 * Inputs:
 *   - `package.json` → `name`, `version`, `license`, `bin`.
 *   - `prompts/agent-profiles/*.md` → body sections; order from
 *     `cli.getMetadata().prompts.agents` (first section becomes the
 *     frontmatter description).
 *   - `prompts/skill/intro.md` → H1 + intro paragraph.
 *
 * The installation section is generated below from the package name and the
 * binary resolved via `package.json#bin`. `{{PACKAGE_NAME}}` is substituted
 * in any file source.
 */
import fs from 'node:fs';
import path from 'node:path';
import { cli } from '../src/cli.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const AGENT_PROFILES_DIR = path.join(PROJECT_ROOT, 'prompts', 'agent-profiles');
const SKILL_ONLY_DIR = path.join(PROJECT_ROOT, 'prompts', 'skill');

interface PackageJson {
  name: string;
  version: string;
  license?: string;
  bin?: string | Record<string, string>;
}

const pkg = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
) as PackageJson;

// Resolve the binary name per npm rules: object form → first key; string
// form → package name with `@scope/` stripped.
function getBinaryName(p: PackageJson): string {
  if (typeof p.bin === 'string') return p.name.replace(/^@[^/]+\//, '');
  if (p.bin && typeof p.bin === 'object') {
    const keys = Object.keys(p.bin);
    if (keys.length === 0) throw new Error('package.json#bin is empty.');
    return keys[0];
  }
  throw new Error('package.json has no `bin` entry.');
}

const binaryName = getBinaryName(pkg);

const agentProfiles = Object.values(cli.getMetadata().prompts?.agents ?? {});
if (agentProfiles.length === 0) {
  throw new Error('No agent profile in cli metadata.');
}
const profileSections = agentProfiles[0].sections;
if (profileSections.length === 0) {
  throw new Error('Agent profile has no sections.');
}
const [descriptionFile, ...bodyProfileSections] = profileSections;

function readSource(dir: string, file: string): string {
  return fs.readFileSync(path.join(dir, file), 'utf8').trim();
}

function applyPlaceholders(text: string): string {
  return text.replaceAll('{{PACKAGE_NAME}}', pkg.name);
}

// `critical.md` → `Critical`; `known-issues.md` → `Known Issues`.
function fileNameToHeading(file: string): string {
  return file
    .replace(/\.md$/i, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function buildInstallationSection(): string {
  return `## Installation

The npm package is \`${pkg.name}\`; the installed binary is \`${binaryName}\`.

Check first: \`command -v ${binaryName}\`. If missing, prefer the ephemeral form (no global install needed, always pulls the latest version):

\`\`\`bash
pnpm dlx ${pkg.name} <cmd>   # or: npx, bunx, yarn dlx
\`\`\`

Use a global install only if the user asks for one:

\`\`\`bash
npm  install -g ${pkg.name}
pnpm add     -g ${pkg.name}
bun  install -g ${pkg.name}
\`\`\``;
}

const description = applyPlaceholders(readSource(AGENT_PROFILES_DIR, descriptionFile))
  .split(/\s+/)
  .join(' ')
  .trim();

const frontmatter = [
  '---',
  `name: ${binaryName}`,
  `description: ${description}`,
  `license: ${pkg.license ?? 'AGPL-3.0-only'}`,
  'metadata:',
  '  author: Powerhouse',
  `  version: "${pkg.version}"`,
  '---',
].join('\n');

type BodySource =
  | { kind: 'file'; dir: string; file: string }
  | { kind: 'generated'; content: string };

// Installation comes first in the body (right after the description /
// intro), then the agent-profile sections in their declared order.
const bodySources: BodySource[] = [
  { kind: 'generated', content: buildInstallationSection() },
  ...bodyProfileSections.map(
    (file): BodySource => ({ kind: 'file', dir: AGENT_PROFILES_DIR, file }),
  ),
];

const body = bodySources
  .map((s) => {
    if (s.kind === 'generated') return s.content;
    return `## ${fileNameToHeading(s.file)}\n\n${applyPlaceholders(readSource(s.dir, s.file))}`;
  })
  .join('\n\n');

const skillMd = [frontmatter, '', body, ''].join('\n');

const outDir = path.join(PROJECT_ROOT, binaryName);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'SKILL.md'), skillMd, 'utf8');
console.log(
  `OK ${binaryName}/SKILL.md (${skillMd.length} chars, description=${description.length} chars, ${bodySources.length} body sections from ${profileSections.length} profile sections)`,
);
