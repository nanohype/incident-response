/**
 * /marshal help — list commands.
 */

import type { CommandContext, CommandHandler } from '../services/command-registry.js';

export function makeHelpHandler(): CommandHandler {
  return async (ctx: CommandContext): Promise<void> => {
    await ctx.respond({
      text: [
        '*Marshal Commands:*',
        '`/marshal status` — current incident status',
        '`/marshal status draft` — generate a status page draft for IC approval',
        '`/marshal resolve` — mark incident resolved, create postmortem, collect pulse rating',
        '`/marshal checklist` — refresh the pinned checklist',
        '`/marshal silence` — pause 15-minute status reminders',
        '`/marshal help` — this message',
      ].join('\n'),
    });
  };
}
