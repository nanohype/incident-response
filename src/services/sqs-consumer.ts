/**
 * SQS consumer loop for the Marshal incident processor.
 * Long-polling; DLQ-safe (no delete on processing failure).
 */

import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, Message } from '@aws-sdk/client-sqs';
import { logger } from '../utils/logger.js';
import { GrafanaOnCallAlertPayload } from '../types/index.js';
import { context, extractSqsTraceContext } from '../utils/tracing.js';

export type IncidentEventType = 'ALERT_RECEIVED' | 'ALERT_RESOLVED';
export type NudgeEventType = 'STATUS_UPDATE_NUDGE' | 'SLA_CHECK';
export interface IncidentQueueMessage {
  type: IncidentEventType;
  payload: GrafanaOnCallAlertPayload;
}
export interface NudgeQueueMessage {
  type: NudgeEventType;
  incident_id: string;
  channel_id?: string;
}
export type MessageHandler<T> = (message: T) => Promise<void>;

export class SqsConsumer {
  private readonly sqs: SQSClient;
  private running = false;

  constructor(
    private readonly incidentQueueUrl: string,
    private readonly nudgeQueueUrl: string,
    private readonly onIncidentEvent: MessageHandler<IncidentQueueMessage>,
    private readonly onNudgeEvent: MessageHandler<NudgeQueueMessage>,
    private readonly pollIntervalMs = 1000,
  ) {
    this.sqs = new SQSClient({ region: process.env['AWS_REGION'] ?? 'us-west-2' });
  }

  start(): void {
    this.running = true;
    logger.info('SQS consumer started');
    void this.pollLoop();
  }
  stop(): void {
    this.running = false;
    logger.info('SQS consumer stopping');
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      await Promise.all([
        this.pollQueue<IncidentQueueMessage>(this.incidentQueueUrl, this.onIncidentEvent, 'incident-events'),
        this.pollQueue<NudgeQueueMessage>(this.nudgeQueueUrl, this.onNudgeEvent, 'nudge-events'),
      ]);
      if (this.running) await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  private async pollQueue<T>(queueUrl: string, handler: MessageHandler<T>, queueName: string): Promise<void> {
    let messages: Message[] = [];
    try {
      const result = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 5,
          MessageAttributeNames: ['All'],
          AttributeNames: ['All'],
        }),
      );
      messages = result.Messages ?? [];
    } catch (err) {
      logger.warn({ queue: queueName, error: err instanceof Error ? err.message : String(err) }, 'SQS receive failed');
      return;
    }

    for (const msg of messages) {
      if (!msg.Body) {
        await this.del(queueUrl, msg.ReceiptHandle!);
        continue;
      }
      let parsed: T;
      try {
        parsed = JSON.parse(msg.Body) as T;
      } catch {
        logger.warn({ queue: queueName }, 'Failed to parse SQS message');
        await this.del(queueUrl, msg.ReceiptHandle!);
        continue;
      }
      // Continue the W3C trace from the sender (webhook Lambda) across the SQS hop.
      // Handler spans parent off the extracted context; auto-instrumentation already
      // records the aws.sqs.receive span that wraps the poll itself.
      const parentCtx = extractSqsTraceContext(msg.MessageAttributes);
      try {
        await context.with(parentCtx, () => handler(parsed));
        await this.del(queueUrl, msg.ReceiptHandle!);
      } catch (err) {
        logger.error(
          {
            queue: queueName,
            error: err instanceof Error ? err.message : String(err),
            receive_count: msg.Attributes?.['ApproximateReceiveCount'],
          },
          'Message processing failed — retrying via SQS visibility timeout',
        );
      }
    }
  }

  private async del(queueUrl: string, receiptHandle: string): Promise<void> {
    try {
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Failed to delete SQS message');
    }
  }
}
