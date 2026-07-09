/**
 * Slack signed-HTTP surface types.
 *
 * The app receives Slack slash commands and Block Kit interactivity as
 * signature-verified HTTP POSTs to a Request URL. These are the minimal shapes
 * the dispatch layer needs — a hand-rolled subset of the fields Slack sends, so
 * no framework type dependency leaks into the command registry.
 */

import type { Block, KnownBlock } from '@slack/types';

/** The reply payload posted back to a Slack `response_url`. */
export interface SlackRespondArguments {
  text?: string;
  blocks?: (KnownBlock | Block)[];
  /** `ephemeral` (default, only the invoker sees it) or `in_channel`. */
  response_type?: 'ephemeral' | 'in_channel';
  /** Replace the message the interaction originated from. */
  replace_original?: boolean;
  /** Delete the originating message. */
  delete_original?: boolean;
}

/**
 * Deferred reply function. Posts to the interaction's `response_url`. A bare
 * string is shorthand for `{ text }`. Mirrors the ergonomics the command +
 * action handlers were written against so their bodies are unchanged.
 */
export type RespondFn = (message: string | SlackRespondArguments) => Promise<void>;

/**
 * Parsed Slack slash-command payload (the `application/x-www-form-urlencoded`
 * body of a `POST` to the command Request URL). Only the fields the dispatch
 * path reads are modelled.
 */
export interface SlashCommand {
  command: string;
  text: string;
  user_id: string;
  channel_id: string;
  team_id: string;
  response_url: string;
  trigger_id: string;
}
