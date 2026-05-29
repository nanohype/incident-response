/**
 * NudgeScheduler — 15-minute status update reminders via EventBridge Scheduler.
 * Per-incident rules; survive ECS task restarts.
 * IC silence → DISABLED (not deleted) + audit logged.
 */

import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  UpdateScheduleCommand,
  FlexibleTimeWindowMode,
  ScheduleState,
  ResourceNotFoundException,
} from '@aws-sdk/client-scheduler';
import { logger } from '../utils/logger.js';

export class NudgeScheduler {
  private readonly scheduler: SchedulerClient;

  constructor(
    private readonly schedulerRoleArn: string,
    private readonly nudgeQueueArn: string,
    awsRegion: string,
    /**
     * EventBridge Scheduler group name. Staging and production share the same
     * codebase but land schedules in separate groups (`marshal-staging`,
     * `marshal-production`) so their rules don't collide — and the task role
     * IAM is scoped to `schedule/${groupName}/*`.
     */
    private readonly groupName: string,
  ) {
    this.scheduler = new SchedulerClient({ region: awsRegion });
  }

  async scheduleNudge(incidentId: string, channelId: string): Promise<void> {
    try {
      await this.scheduler.send(
        new CreateScheduleCommand({
          Name: this.name(incidentId),
          GroupName: this.groupName,
          ScheduleExpression: 'rate(15 minutes)',
          ScheduleExpressionTimezone: 'UTC',
          State: ScheduleState.ENABLED,
          FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.FLEXIBLE, MaximumWindowInMinutes: 1 },
          Target: {
            Arn: this.nudgeQueueArn,
            RoleArn: this.schedulerRoleArn,
            Input: JSON.stringify({ type: 'STATUS_UPDATE_NUDGE', incident_id: incidentId, channel_id: channelId }),
          },
          Description: `Marshal 15-min status nudge for incident ${incidentId}`,
        }),
      );
      logger.info({ incident_id: incidentId, group: this.groupName }, 'Nudge schedule created');
    } catch (err) {
      logger.warn(
        { incident_id: incidentId, error: err instanceof Error ? err.message : String(err) },
        'Failed to create nudge schedule — nudges will not fire for this incident',
      );
    }
  }

  async deleteNudge(incidentId: string): Promise<void> {
    try {
      await this.scheduler.send(new DeleteScheduleCommand({ Name: this.name(incidentId), GroupName: this.groupName }));
      logger.info({ incident_id: incidentId, group: this.groupName }, 'Nudge schedule deleted');
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return;
      logger.warn({ incident_id: incidentId, error: err instanceof Error ? err.message : String(err) }, 'Failed to delete nudge schedule');
    }
  }

  async pauseNudge(incidentId: string): Promise<void> {
    try {
      const ex = await this.scheduler.send(new GetScheduleCommand({ Name: this.name(incidentId), GroupName: this.groupName }));
      await this.scheduler.send(
        new UpdateScheduleCommand({
          Name: this.name(incidentId),
          GroupName: this.groupName,
          State: ScheduleState.DISABLED,
          ScheduleExpression: ex.ScheduleExpression!,
          FlexibleTimeWindow: ex.FlexibleTimeWindow!,
          Target: ex.Target!,
        }),
      );
      logger.info({ incident_id: incidentId, group: this.groupName }, 'Nudge schedule paused (IC silenced)');
    } catch (err) {
      logger.warn({ incident_id: incidentId, error: err instanceof Error ? err.message : String(err) }, 'Failed to pause nudge schedule');
    }
  }

  private name(incidentId: string): string {
    return `marshal-nudge-${incidentId.replace(/[^a-zA-Z0-9-_]/g, '-').substring(0, 50)}`;
  }
}
