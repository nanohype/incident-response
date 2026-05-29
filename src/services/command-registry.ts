/**
 * CommandRegistry — typed dispatcher for Marshal slash commands.
 *
 * Adding a new slash command = create a CommandHandler, register it here.
 * No edits to src/index.ts required.
 */

import { z } from 'zod';
import type { RespondFn, SlashCommand } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';

/**
 * Slash command text bounds. Protects the downstream audit write from a
 * 400 KB DynamoDB-item DOS (authenticated workspace member pasting a giant
 * blob into `/marshal ...`). Args are kept short by shape: name + up to
 * a handful of tokens.
 */
export const SlashCommandTextSchema = z.string().max(500);
export const SlashCommandArgsSchema = z.array(z.string().max(100)).max(10);

export interface CommandContext {
  readonly subCommand: string;
  readonly args: string[];
  readonly incidentId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly rawCommand: SlashCommand;
  readonly slack: WebClient;
  readonly respond: RespondFn;
}

export type CommandHandler = (ctx: CommandContext) => Promise<void>;

export class CommandRegistry {
  private readonly handlers = new Map<string, CommandHandler>();

  register(name: string, handler: CommandHandler): this {
    this.handlers.set(name.toLowerCase(), handler);
    return this;
  }

  registeredCommands(): string[] {
    return Array.from(this.handlers.keys());
  }

  async dispatch(ctx: CommandContext): Promise<void> {
    const handler = this.handlers.get(ctx.subCommand.toLowerCase());
    if (!handler) {
      await ctx.respond({ text: `Unknown command: \`${ctx.subCommand}\`. Try \`/marshal help\`.` });
      return;
    }
    await handler(ctx);
  }
}
