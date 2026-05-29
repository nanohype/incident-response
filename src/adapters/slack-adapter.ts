/**
 * SlackAdapter — port over @slack/web-api WebClient.
 *
 * Bakes the timeout/fail-mode discipline into the call site so domain code
 * cannot reach past it. Critical-path operations throw on timeout
 * (war-room channel-create depends on completion); non-critical operations
 * degrade gracefully with a warn-log audit event so the IC sees that
 * something didn't post.
 *
 * The CI gate `Adapter-gate invariant — no raw WebClient outside wiring +
 * slack-adapter` enforces that domain services depend on this port, not on
 * `new WebClient()`.
 */

import type { WebClient } from '@slack/web-api';
import type { Block, KnownBlock } from '@slack/types';
import { withTimeout, withTimeoutOrDefault } from '../utils/with-timeout.js';

export interface SlackChannel {
  id: string;
  name: string;
}

export interface SlackPostResult {
  ok: boolean;
  ts?: string;
}

export interface SlackUserRef {
  id: string;
}

export interface SlackCallOpts {
  timeoutMs: number;
  label: string;
}

export interface SlackNonCriticalCallOpts extends SlackCallOpts {
  incidentId?: string;
}

export interface PostMessageArgs {
  channel: string;
  text: string;
  blocks?: (KnownBlock | Block)[];
}

export interface SlackAdapter {
  /** Critical: throws on timeout or non-ok response. War-room assembly aborts. */
  createPrivateChannel(name: string, opts: SlackCallOpts): Promise<SlackChannel>;

  /** Critical: throws on timeout. Caller decides what to do with !ok responses. */
  postMessageCritical(args: PostMessageArgs, opts: SlackCallOpts): Promise<SlackPostResult>;

  /** Non-critical: returns undefined on timeout/failure, warn-logs with incident_id. */
  postMessageNonCritical(args: PostMessageArgs, opts: SlackNonCriticalCallOpts): Promise<SlackPostResult | undefined>;

  /** Non-critical: silently swallows failures (pinning is cosmetic). */
  pinMessage(channel: string, timestamp: string, opts: SlackNonCriticalCallOpts): Promise<void>;

  /** Critical-ish: throws on timeout, returns null when Slack returns no user. */
  lookupUserByEmail(email: string, opts: SlackCallOpts): Promise<SlackUserRef | null>;

  /** Critical-ish: throws on timeout (caller catches per-invite to keep the loop going). */
  inviteToChannel(channel: string, userId: string, opts: SlackCallOpts): Promise<void>;
}

export function createSlackAdapter(client: WebClient): SlackAdapter {
  return {
    async createPrivateChannel(name, { timeoutMs, label }) {
      const res = await withTimeout(client.conversations.create({ name, is_private: true }), timeoutMs, label);
      if (!res.ok || !res.channel?.id) {
        throw new Error(`Failed to create Slack channel: ${res.error ?? 'unknown'}`);
      }
      return { id: res.channel.id, name: res.channel.name ?? name };
    },

    async postMessageCritical(args, { timeoutMs, label }) {
      const res = await withTimeout(client.chat.postMessage(args), timeoutMs, label);
      const out: SlackPostResult = { ok: !!res.ok };
      if (res.ts) out.ts = res.ts;
      return out;
    },

    async postMessageNonCritical(args, { timeoutMs, label, incidentId }) {
      const res = await withTimeoutOrDefault(client.chat.postMessage(args), timeoutMs, label, undefined, incidentId);
      if (!res) return undefined;
      const out: SlackPostResult = { ok: !!res.ok };
      if (res.ts) out.ts = res.ts;
      return out;
    },

    async pinMessage(channel, timestamp, { timeoutMs, label, incidentId }) {
      await withTimeoutOrDefault(client.pins.add({ channel, timestamp }), timeoutMs, label, undefined, incidentId);
    },

    async lookupUserByEmail(email, { timeoutMs, label }) {
      const res = await withTimeout(client.users.lookupByEmail({ email }), timeoutMs, label);
      if (!res.ok || !res.user?.id) return null;
      return { id: res.user.id };
    },

    async inviteToChannel(channel, userId, { timeoutMs, label }) {
      await withTimeout(client.conversations.invite({ channel, users: userId }), timeoutMs, label);
    },
  };
}
