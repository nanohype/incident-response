/**
 * External client tests.
 *
 * Every client builds its own `HttpClient`, so `fetch` is the seam — which is
 * the right one anyway: fetch is the process edge, and stubbing it leaves the
 * real HttpClient (timeouts, retry cap, status handling) and the real client
 * mapping in the path. Nothing between the call and the socket is faked.
 *
 * The line these tests draw is between a client that degrades and one that
 * raises. War-room context is best-effort — a GitHub outage must not stop the
 * channel from being created, so those return empty and log. Statuspage writes
 * are the opposite: they are customer-facing, they sit behind the approval
 * gate, and a silent failure there means the gate records a publish that never
 * happened.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { GitHubClient } from "../../src/clients/github-client.js";
import { GrafanaOnCallClient } from "../../src/clients/grafana-oncall-client.js";
import { StatuspageClient } from "../../src/clients/statuspage-client.js";

const realFetch = globalThis.fetch;
let requests: Array<{ url: string; init: RequestInit | undefined }>;

type Reply = { status?: number; body?: unknown };

function stubFetch(responder: (url: string, init?: RequestInit) => Reply) {
  requests = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    const { status = 200, body = {} } = responder(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("StatuspageClient — the customer-facing writes", () => {
  const client = () => new StatuspageClient("sp-key", "page_1");

  it("authenticates with the OAuth scheme Statuspage expects", async () => {
    stubFetch(() => ({ body: [] }));
    await client().listComponents();

    const headers = requests[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("OAuth sp-key");
  });

  it("opens an incident as investigating, on the configured page", async () => {
    stubFetch(() => ({ body: { id: "sp_1", name: "API degraded" } }));
    const incident = await client().createIncident(
      "API degraded",
      "We are looking",
      ["c1"],
      "INC-1",
    );

    expect(requests[0].url).toContain("/v1/pages/page_1/incidents");
    expect(requests[0].init?.method).toBe("POST");
    const sent = JSON.parse(String(requests[0].init?.body)) as {
      incident: Record<string, unknown>;
    };
    expect(sent.incident).toMatchObject({
      name: "API degraded",
      status: "investigating",
      body: "We are looking",
      component_ids: ["c1"],
      deliver_notifications: true,
    });
    expect(incident.id).toBe("sp_1");
  });

  it("throws when a create fails, rather than reporting a publish that did not happen", async () => {
    // The approval gate writes STATUSPAGE_DRAFT_APPROVED before calling this.
    // A swallowed failure here leaves an audit trail saying a customer-facing
    // message went out when none did.
    stubFetch(() => ({ status: 422, body: { error: "invalid component" } }));

    await expect(client().createIncident("x", "y", [], "INC-1")).rejects.toThrow(/422/);
  });

  it("throws when an update fails", async () => {
    stubFetch(() => ({ status: 500 }));
    await expect(client().updateIncident("sp_1", "body", "resolved", "INC-1")).rejects.toThrow(
      /500/,
    );
  });

  it("returns an empty component list rather than throwing when the read fails", async () => {
    // Reads are used to populate a picker. Degrading is fine here; the write
    // path above is where failure must be loud.
    stubFetch(() => ({ status: 503 }));
    await expect(client().listComponents()).resolves.toEqual([]);
  });
});

describe("GitHubClient — best-effort war-room context", () => {
  const client = () => new GitHubClient("ghp_token", "nanohype");

  it("maps the API commit shape onto the timeline entry", async () => {
    stubFetch(() => ({
      body: [
        {
          sha: "abcdef1234567890",
          html_url: "https://github.com/nanohype/api/commit/abcdef1",
          commit: {
            message: "fix: bound the retry\n\nlonger body",
            author: { name: "Ada", date: "2026-07-20T10:00:00Z" },
          },
          author: { login: "ada" },
        },
      ],
    }));

    const commits = await client().getRecentCommits("api", "INC-1");

    expect(commits).toEqual([
      {
        sha: "abcdef12",
        // Only the subject line — a full body would flood the war-room message.
        message: "fix: bound the retry",
        author: "Ada",
        timestamp: "2026-07-20T10:00:00Z",
        url: "https://github.com/nanohype/api/commit/abcdef1",
      },
    ]);
  });

  it("falls back to the login when the commit carries no author name", async () => {
    stubFetch(() => ({
      body: [{ sha: "aaaaaaa", html_url: "u", commit: { message: "m" }, author: { login: "ada" } }],
    }));
    expect((await client().getRecentCommits("api", "INC-1"))[0].author).toBe("ada");
  });

  it("says unknown rather than crashing when there is no author at all", async () => {
    stubFetch(() => ({ body: [{ sha: "aaaaaaa", html_url: "u", commit: { message: "m" } }] }));
    expect((await client().getRecentCommits("api", "INC-1"))[0].author).toBe("unknown");
  });

  it("returns no commits rather than failing the war room when GitHub is down", async () => {
    stubFetch(() => ({ status: 503 }));
    await expect(client().getRecentCommits("api", "INC-1")).resolves.toEqual([]);
  });

  it("tries each CODEOWNERS location in turn and stops at the first hit", async () => {
    const content = Buffer.from("# comment\n/src/api  @team-api @ada\n\n").toString("base64");
    stubFetch((url) =>
      url.includes(".github/CODEOWNERS")
        ? { body: { content, encoding: "base64" } }
        : { status: 404 },
    );

    const owners = await client().getCodeOwners("api", "INC-1");

    expect(requests.map((r) => r.url.split("/contents/")[1])).toEqual([
      "CODEOWNERS",
      ".github/CODEOWNERS",
    ]);
    expect(owners).toEqual([{ pattern: "/src/api", owners: ["@team-api", "@ada"] }]);
  });

  it("drops comment lines and entries with no owners", async () => {
    const content = Buffer.from("# just a comment\n/orphan\n/src @ada\n").toString("base64");
    stubFetch(() => ({ body: { content, encoding: "base64" } }));

    expect(await client().getCodeOwners("api", "INC-1")).toEqual([
      { pattern: "/src", owners: ["@ada"] },
    ]);
  });

  it("returns nothing when no CODEOWNERS file exists anywhere", async () => {
    stubFetch(() => ({ status: 404 }));
    await expect(client().getCodeOwners("api", "INC-1")).resolves.toEqual([]);
  });
});

describe("GrafanaOnCallClient", () => {
  const client = () => new GrafanaOnCallClient("grafana-token", "https://oncall.example.com");

  it("returns null when no one is on call rather than inventing a responder", async () => {
    stubFetch(() => ({ body: { users: [] } }));
    await expect(client().getCurrentOnCallUser("sched_1")).resolves.toBeNull();
  });

  it("returns null when the schedule lookup fails", async () => {
    stubFetch(() => ({ status: 500 }));
    await expect(client().getCurrentOnCallUser("sched_1")).resolves.toBeNull();
  });

  it("reports whether an acknowledge landed", async () => {
    stubFetch(() => ({ status: 200 }));
    await expect(client().acknowledgeAlertGroup("ag_1")).resolves.toBe(true);

    stubFetch(() => ({ status: 500 }));
    await expect(client().acknowledgeAlertGroup("ag_1")).resolves.toBe(false);
  });

  it("reports whether a resolve landed", async () => {
    stubFetch(() => ({ status: 500 }));
    // Silent stubs are bugs — the IC is told what did and did not happen, so
    // this has to answer honestly rather than always returning true.
    await expect(client().resolveAlertGroup("ag_1")).resolves.toBe(false);
  });
});
