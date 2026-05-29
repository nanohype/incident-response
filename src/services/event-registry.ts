/**
 * EventRegistry — dispatcher for SQS incident and nudge events.
 *
 * Decouples event type → handler mapping from the main loop.
 */

import { logger } from '../utils/logger.js';

export interface DispatchableMessage {
  type: string;
}
export type EventHandler<T extends DispatchableMessage> = (message: T) => Promise<void>;

export class EventRegistry<T extends DispatchableMessage> {
  private readonly handlers = new Map<string, EventHandler<T>>();
  constructor(private readonly name: string) {}

  on(eventType: string, handler: EventHandler<T>): this {
    this.handlers.set(eventType, handler);
    return this;
  }

  registeredTypes(): string[] {
    return Array.from(this.handlers.keys());
  }

  async dispatch(message: T): Promise<void> {
    const handler = this.handlers.get(message.type);
    if (!handler) {
      logger.warn({ registry: this.name, event_type: message.type }, 'No handler registered for event type — dropping message');
      return;
    }
    await handler(message);
  }
}
