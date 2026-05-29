/**
 * /marshal silence — pause 15-minute status reminders for this incident.
 */

import type { CommandContext, CommandHandler } from '../services/command-registry.js';
import type { NudgeScheduler } from '../services/nudge-scheduler.js';
import type { AuditWriter } from '../utils/audit.js';

export function makeSilenceHandler(deps: { nudgeScheduler: NudgeScheduler; auditWriter: AuditWriter }): CommandHandler {
  return async (ctx: CommandContext): Promise<void> => {
    await deps.nudgeScheduler.pauseNudge(ctx.incidentId);
    await deps.auditWriter.write(ctx.incidentId, ctx.userId, 'STATUS_REMINDER_SILENCED', {
      silenced_at: new Date().toISOString(),
      channel_id: ctx.channelId,
    });
    await ctx.respond({ text: '🔕 Status update reminders silenced. Recorded in audit log.' });
  };
}
