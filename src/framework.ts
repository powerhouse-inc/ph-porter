/**
 * Per-CLI typed framework binding.
 *
 * This file is USER-OWNED. ph-clint-cli emits it once at project
 * creation and never overwrites it afterwards — edit `configSchema`
 * and `secretsSchema` freely.
 */
import { z } from 'zod';
import { createTypes } from '@powerhousedao/ph-clint';

export const configSchema = z.object({
  // @clint:begin framework-config
  model: z.string().default('anthropic/claude-haiku-4-5').describe('LLM model to use'),
  agentLogging: z.boolean().default(false).describe('Enable agent conversation logging'),
  // @clint:end framework-config
});

export const secretsSchema = z.object({
  // @clint:begin framework-secrets
  anthropicApiKey: z.string().optional().describe('anthropic API key'),
  // @clint:end framework-secrets
});

export type Config = z.infer<typeof configSchema> &
  z.infer<typeof secretsSchema>;

const fullConfigSchema = configSchema.extend(secretsSchema.shape);

/**
 * No reactor package — bind `createTypes` directly so
 * `defineCommand` / `defineTrigger` / `defineService` still pick up
 * the typed config. Enable `features.powerhouse` in the project spec
 * and codegen will switch these exports to a registry-backed
 * `framework.gen.ts`.
 */
export const {
  defineCommand,
  defineTrigger,
  defineService,
  createDocumentChangeTrigger,
} = createTypes({ configSchema: fullConfigSchema });
