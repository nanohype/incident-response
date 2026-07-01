/**
 * Zod-validated environment configuration.
 *
 * Values with sane defaults live here so they are overridable per
 * environment without a code change. Required, no-default env vars
 * (tokens, table names, queue URLs) are asserted at startup by
 * `requireEnv` in src/index.ts — this module never exits a healthy
 * process over an optional value.
 */

import { z } from 'zod';
import { logger } from '../utils/logger.js';

const ConfigSchema = z.object({
  // Bedrock model IDs. Sonnet drafts status pages + postmortem narrative;
  // Haiku classifies IC messages. Override per environment (e.g. to pin a
  // dated snapshot or a cross-region inference profile).
  BEDROCK_SONNET_MODEL_ID: z.string().min(1).default('anthropic.claude-sonnet-4-6'),
  BEDROCK_HAIKU_MODEL_ID: z.string().min(1).default('anthropic.claude-haiku-4-5-20251001-v1:0'),
});

function loadConfig(): z.infer<typeof ConfigSchema> {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    logger.error({ issues: parsed.error.issues }, 'Invalid configuration');
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();
export type Config = z.infer<typeof ConfigSchema>;
