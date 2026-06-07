/**
 * /incident-response help — list commands.
 */

import type { CommandContext, CommandHandler } from '../services/command-registry.js';

export function makeHelpHandler(): CommandHandler {
  return async (ctx: CommandContext): Promise<void> => {
    await ctx.respond({
      text: [
        '*IncidentResponse Commands:*',
        '`/incident-response status` — current incident status',
        '`/incident-response status draft` — generate a status page draft for IC approval',
        '`/incident-response resolve` — mark incident resolved, create postmortem, collect pulse rating',
        '`/incident-response checklist` — refresh the pinned checklist',
        '`/incident-response silence` — pause 15-minute status reminders',
        '`/incident-response help` — this message',
      ].join('\n'),
    });
  };
}
