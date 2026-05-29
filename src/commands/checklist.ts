/**
 * /marshal checklist — acknowledge the request to refresh the pinned checklist.
 * Full re-pin implementation will follow in v0.2; for v0.1 we respond honestly.
 */

import type { CommandContext, CommandHandler } from '../services/command-registry.js';

export function makeChecklistHandler(): CommandHandler {
  return async (ctx: CommandContext): Promise<void> => {
    await ctx.respond({
      text: '📋 The pinned checklist in this channel is the source of truth. Re-pin via `/marshal checklist refresh` is planned for v0.2.',
    });
  };
}
