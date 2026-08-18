/**
 * Unit tests for the Slack adapter.
 *
 * The adapter exists to bake the timeout and fail-mode discipline into the call
 * site so domain code cannot bypass it — every method decides, on behalf of its
 * caller, whether a Slack failure is fatal or survivable. That decision is the
 * behaviour under test here, not the WebClient call itself.
 *
 * `createSlackAdapter` takes a WebClient, so the seam is the constructor
 * argument and a plain fake suffices. Nothing is module-mocked; the real
 * `withTimeout` / `withTimeoutOrDefault` wrappers stay in the path.
 */

import { describe, expect, it, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import { createSlackAdapter } from "../../src/adapters/slack-adapter.js";

const opts = { timeoutMs: 1000, label: "test" };
const nonCritical = { timeoutMs: 1000, label: "test", incidentId: "inc-1" };

/** A WebClient with only the surfaces the adapter touches. */
function fakeClient(overrides: Record<string, unknown> = {}) {
  const client = {
    conversations: {
      create: vi.fn().mockResolvedValue({ ok: true, channel: { id: "C1", name: "war-room" } }),
      invite: vi.fn().mockResolvedValue({ ok: true }),
    },
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "1.0" }) },
    pins: { add: vi.fn().mockResolvedValue({ ok: true }) },
    users: { lookupByEmail: vi.fn().mockResolvedValue({ ok: true, user: { id: "U1" } }) },
    ...overrides,
  };
  return client as unknown as WebClient;
}

/** A promise that never settles, to drive the timeout arms. */
const never = () => new Promise(() => {});

describe("createSlackAdapter", () => {
  describe("createPrivateChannel — critical", () => {
    it("SA-001: returns the created channel", async () => {
      const adapter = createSlackAdapter(fakeClient());
      await expect(adapter.createPrivateChannel("war-room", opts)).resolves.toEqual({
        id: "C1",
        name: "war-room",
      });
    });

    it("SA-002: falls back to the requested name when Slack omits one", async () => {
      const client = fakeClient({
        conversations: {
          create: vi.fn().mockResolvedValue({ ok: true, channel: { id: "C1" } }),
          invite: vi.fn(),
        },
      });
      await expect(
        createSlackAdapter(client).createPrivateChannel("asked-for", opts),
      ).resolves.toEqual({ id: "C1", name: "asked-for" });
    });

    it("SA-003: throws with Slack's own error when creation is refused", async () => {
      // name_taken is the one the nonce in the channel name exists to avoid, so
      // the reason has to reach the log rather than being flattened to "failed".
      const client = fakeClient({
        conversations: {
          create: vi.fn().mockResolvedValue({ ok: false, error: "name_taken" }),
          invite: vi.fn(),
        },
      });
      await expect(
        createSlackAdapter(client).createPrivateChannel("war-room", opts),
      ).rejects.toThrow(/name_taken/);
    });

    it("SA-004: throws when Slack reports ok but returns no channel id", async () => {
      // Without the id there is nothing to invite anyone into. Returning a
      // half-built channel would fail later, somewhere less obvious.
      const client = fakeClient({
        conversations: { create: vi.fn().mockResolvedValue({ ok: true }), invite: vi.fn() },
      });
      await expect(
        createSlackAdapter(client).createPrivateChannel("war-room", opts),
      ).rejects.toThrow(/unknown/);
    });

    it("SA-005: throws on timeout rather than assembling without a room", async () => {
      const client = fakeClient({
        conversations: { create: vi.fn().mockImplementation(never), invite: vi.fn() },
      });
      await expect(
        createSlackAdapter(client).createPrivateChannel("war-room", { timeoutMs: 10, label: "t" }),
      ).rejects.toThrow();
    });
  });

  describe("postMessage — the critical/non-critical split", () => {
    it("SA-010: critical post reports ok and carries the timestamp", async () => {
      const adapter = createSlackAdapter(fakeClient());
      await expect(
        adapter.postMessageCritical({ channel: "C1", text: "hi" }, opts),
      ).resolves.toEqual({ ok: true, ts: "1.0" });
    });

    it("SA-011: critical post omits ts entirely when Slack returns none", async () => {
      // `exactOptionalPropertyTypes` — absent, not `ts: undefined`, so a caller
      // checking `msg.ts` cannot pin against an explicit undefined.
      const client = fakeClient({ chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) } });
      const res = await createSlackAdapter(client).postMessageCritical(
        { channel: "C1", text: "hi" },
        opts,
      );
      expect(res).toEqual({ ok: true });
      expect("ts" in res).toBe(false);
    });

    it("SA-012: critical post throws on timeout", async () => {
      const client = fakeClient({ chat: { postMessage: vi.fn().mockImplementation(never) } });
      await expect(
        createSlackAdapter(client).postMessageCritical(
          { channel: "C1", text: "hi" },
          { timeoutMs: 10, label: "t" },
        ),
      ).rejects.toThrow();
    });

    it("SA-013: non-critical post returns undefined on timeout instead of throwing", async () => {
      // This is the whole distinction. The war room is already assembled by the
      // time these run; a wedged Slack call must cost the message, not the
      // assembly.
      const client = fakeClient({ chat: { postMessage: vi.fn().mockImplementation(never) } });
      const res = await createSlackAdapter(client).postMessageNonCritical(
        { channel: "C1", text: "hi" },
        { timeoutMs: 10, label: "t", incidentId: "inc-1" },
      );
      expect(res).toBeUndefined();
    });

    it("SA-014: non-critical post reports a Slack-level failure as not-ok", async () => {
      // Distinct from the timeout arm: Slack answered, and said no. The caller
      // records attached:false rather than treating it as a missing response.
      const client = fakeClient({
        chat: { postMessage: vi.fn().mockResolvedValue({ ok: false }) },
      });
      const res = await createSlackAdapter(client).postMessageNonCritical(
        { channel: "C1", text: "hi" },
        nonCritical,
      );
      expect(res).toEqual({ ok: false });
    });
  });

  describe("pinMessage — cosmetic", () => {
    it("SA-020: swallows a pin failure", async () => {
      // A missing pin costs the IC a scroll. It must never surface as an
      // assembly failure.
      const client = fakeClient({
        pins: { add: vi.fn().mockRejectedValue(new Error("already_pinned")) },
      });
      await expect(
        createSlackAdapter(client).pinMessage("C1", "1.0", nonCritical),
      ).resolves.toBeUndefined();
    });

    it("SA-021: swallows a pin timeout", async () => {
      const client = fakeClient({ pins: { add: vi.fn().mockImplementation(never) } });
      await expect(
        createSlackAdapter(client).pinMessage("C1", "1.0", {
          timeoutMs: 10,
          label: "t",
          incidentId: "inc-1",
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("lookupUserByEmail — null vs throw", () => {
    it("SA-030: returns the user reference when Slack knows the address", async () => {
      const adapter = createSlackAdapter(fakeClient());
      await expect(adapter.lookupUserByEmail("ic@example.com", opts)).resolves.toEqual({
        id: "U1",
      });
    });

    it("SA-031: returns null for an address Slack does not know", async () => {
      // Null rather than a throw: a directory entry without a Slack account is
      // an ordinary state, and the invite loop skips it without recording a
      // failure the IC would learn to ignore.
      const client = fakeClient({
        users: {
          lookupByEmail: vi.fn().mockResolvedValue({ ok: false, error: "users_not_found" }),
        },
      });
      await expect(
        createSlackAdapter(client).lookupUserByEmail("nobody@example.com", opts),
      ).resolves.toBeNull();
    });

    it("SA-032: returns null when Slack reports ok but no user", async () => {
      const client = fakeClient({
        users: { lookupByEmail: vi.fn().mockResolvedValue({ ok: true }) },
      });
      await expect(
        createSlackAdapter(client).lookupUserByEmail("nobody@example.com", opts),
      ).resolves.toBeNull();
    });

    it("SA-033: throws on timeout so the invite loop records it", async () => {
      // Unlike the not-found case, a timeout is not evidence the human has no
      // account — swallowing it would silently drop a real responder.
      const client = fakeClient({
        users: { lookupByEmail: vi.fn().mockImplementation(never) },
      });
      await expect(
        createSlackAdapter(client).lookupUserByEmail("ic@example.com", {
          timeoutMs: 10,
          label: "t",
        }),
      ).rejects.toThrow();
    });
  });

  describe("inviteToChannel", () => {
    it("SA-040: passes the user through to Slack", async () => {
      const client = fakeClient();
      await createSlackAdapter(client).inviteToChannel("C1", "U1", opts);
      expect(client.conversations.invite).toHaveBeenCalledWith({ channel: "C1", users: "U1" });
    });

    it("SA-041: throws on timeout so the caller can record the failed invite", async () => {
      const client = fakeClient({
        conversations: { create: vi.fn(), invite: vi.fn().mockImplementation(never) },
      });
      await expect(
        createSlackAdapter(client).inviteToChannel("C1", "U1", { timeoutMs: 10, label: "t" }),
      ).rejects.toThrow();
    });
  });
});
