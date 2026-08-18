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
import { GrafanaCloudClient } from "../../src/clients/grafana-cloud-client.js";
import { GrafanaOnCallClient } from "../../src/clients/grafana-oncall-client.js";
import { LinearIncidentResponseClient } from "../../src/clients/linear-client.js";
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

/**
 * GrafanaCloudClient — the war-room context snapshot.
 *
 * This client is best-effort by design: it fans out to Mimir, Loki and Tempo
 * with Promise.allSettled, and a dead datasource must cost the IC that one
 * panel rather than the whole snapshot. These cover the degradation, since the
 * happy path is the case that never happens during an incident.
 */
describe("GrafanaCloudClient — context snapshot degradation", () => {
  const client = () => new GrafanaCloudClient("https://grafana.example", "org-1", "tok");

  /** Route a stubbed reply per datasource by URL path. */
  function stubDatasources(replies: { mimir?: Reply; loki?: Reply; tempo?: Reply }) {
    stubFetch((url) => {
      if (url.includes("/api/prom")) return replies.mimir ?? { body: mimirValue("0") };
      if (url.includes("/loki/")) return replies.loki ?? { body: emptyLoki };
      return replies.tempo ?? { body: { traces: [] } };
    });
  }

  const mimirValue = (v: string) => ({
    status: "success",
    data: { resultType: "vector", result: [{ metric: {}, value: [1, v] as [number, string] }] },
  });
  const emptyLoki = { status: "success", data: { resultType: "streams", result: [] } };

  it("GCC-001: returns a populated snapshot when every datasource answers", async () => {
    stubDatasources({
      mimir: { body: mimirValue("0.25") },
      loki: {
        body: {
          status: "success",
          data: {
            resultType: "streams",
            result: [{ stream: {}, values: [["1", "upstream connect error"]] }],
          },
        },
      },
      tempo: { body: { traces: [{ traceID: "t-1" }] } },
    });

    const snap = await client().getContextSnapshot("payments", "inc-1");

    expect(snap.error_rate_2h.current).toBe(0.25);
    expect(snap.log_excerpts).toEqual(["upstream connect error"]);
    expect(snap.sample_trace_ids).toEqual(["t-1"]);
    // Both arms of the ratio are the same stub, so the burn rate is 1x.
    expect(snap.error_budget_burn_rate).toBe(1);
    expect(snap.datasource_errors).toBeUndefined();
  });

  it("GCC-002: names the failing datasource rather than dropping the snapshot", async () => {
    // Loki down. The IC still gets error rate, latency and traces — losing the
    // log panel must not lose the other three.
    stubDatasources({ loki: { status: 503 }, tempo: { body: { traces: [{ traceID: "t-9" }] } } });

    const snap = await client().getContextSnapshot("payments", "inc-1");

    expect(snap.sample_trace_ids).toEqual(["t-9"]);
    expect(snap.log_excerpts).toEqual([]);
  });

  it("GCC-003: reports zeros rather than guessing when Mimir is unreachable", async () => {
    stubDatasources({ mimir: { status: 500 } });

    const snap = await client().getContextSnapshot("payments", "inc-1");

    expect(snap.error_rate_2h).toEqual({ current: 0, baseline: 0, series_url: "" });
    expect(snap.p99_latency_ms).toEqual({ current: 0, baseline: 0 });
  });

  it("GCC-004: refuses to divide by a zero baseline", async () => {
    // A brand-new service has no 2h baseline. Dividing by it would report an
    // infinite burn rate and page on arithmetic rather than on impact.
    stubDatasources({ mimir: { body: mimirValue("0") } });

    const snap = await client().getContextSnapshot("payments", "inc-1");

    expect(snap.error_budget_burn_rate).toBe(0);
    expect(Number.isFinite(snap.error_budget_burn_rate)).toBe(true);
  });

  it("GCC-005: truncates a log line rather than pasting a whole stack into Slack", async () => {
    stubDatasources({
      loki: {
        body: {
          status: "success",
          data: {
            resultType: "streams",
            result: [{ stream: {}, values: [["1", "x".repeat(500)]] }],
          },
        },
      },
    });

    const snap = await client().getContextSnapshot("payments", "inc-1");

    expect(snap.log_excerpts[0]).toHaveLength(200);
  });

  it("GCC-006: caps excerpts at ten and traces at five", async () => {
    stubDatasources({
      loki: {
        body: {
          status: "success",
          data: {
            resultType: "streams",
            result: [
              {
                stream: {},
                values: Array.from({ length: 25 }, (_, i) => [String(i), `line ${i}`]),
              },
            ],
          },
        },
      },
      tempo: { body: { traces: Array.from({ length: 20 }, (_, i) => ({ traceID: `t-${i}` })) } },
    });

    const snap = await client().getContextSnapshot("payments", "inc-1");

    expect(snap.log_excerpts).toHaveLength(10);
    expect(snap.sample_trace_ids).toHaveLength(5);
  });

  it("GCC-007: treats an unparseable metric value as zero", async () => {
    // Mimir answering 200 with a non-numeric sample is a malformed upstream,
    // not a number — NaN here would propagate into the burn rate and the
    // Slack block.
    stubDatasources({ mimir: { body: mimirValue("not-a-number") } });

    const snap = await client().getContextSnapshot("payments", "inc-1");

    expect(snap.error_rate_2h.current).toBe(0);
    expect(Number.isNaN(snap.error_rate_2h.current)).toBe(false);
  });

  it("GCC-008: scopes every query to the incident's org", async () => {
    stubDatasources({});
    await client().getContextSnapshot("payments", "inc-1");

    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      const headers = r.init?.headers as Record<string, string>;
      expect(headers["X-Scope-OrgID"]).toBe("org-1");
      expect(headers.Authorization).toBe("Bearer tok");
    }
  });
});

/**
 * LinearIncidentResponseClient — the postmortem issue.
 *
 * `@linear/sdk` builds its own transport from an API key, so unlike the other
 * clients there is no fetch seam to stand behind: the SDK instance is replaced
 * on the constructed object, the same way the AI wrapper's Anthropic client is.
 * The client's own mapping, timeout wrapping and failure decisions all still
 * run — only the GraphQL round trip is absent.
 */
describe("LinearIncidentResponseClient — postmortem creation", () => {
  const DATE = new Date("2026-08-18T12:00:00.000Z");

  function build(sdk: Record<string, unknown>) {
    const client = new LinearIncidentResponseClient("key", "proj-1", "team-1");
    (client as unknown as { client: Record<string, unknown> }).client = sdk;
    return client;
  }

  /** An SDK that answers every call this client makes, successfully. */
  function workingSdk(overrides: Record<string, unknown> = {}) {
    return {
      viewer: Promise.resolve({ id: "U-ic" }),
      issueLabels: vi.fn().mockResolvedValue({ nodes: [{ id: "lbl-1" }] }),
      createIssueLabel: vi.fn().mockResolvedValue({ issueLabel: Promise.resolve({ id: "lbl-2" }) }),
      createIssue: vi.fn().mockResolvedValue({
        issue: Promise.resolve({ id: "iss-1", url: "https://linear.app/iss-1" }),
      }),
      ...overrides,
    };
  }

  it("LIN-001: returns the created issue with a 48-hour postmortem deadline", async () => {
    const draft = await build(workingSdk()).createPostmortemDraft(
      "inc-1",
      "API error rate breach",
      "# Postmortem",
      "U-ic",
      "war-room",
      DATE,
    );

    expect(draft.linear_issue_id).toBe("iss-1");
    expect(draft.linear_issue_url).toBe("https://linear.app/iss-1");
    // The title carries the incident date, not the creation date — a postmortem
    // written three days late still belongs to the day it happened.
    expect(draft.title).toContain("2026-08-18");
    const slaHours = (Date.parse(draft.sla_deadline) - Date.parse(draft.created_at)) / 3_600_000;
    expect(Math.round(slaHours)).toBe(48);
  });

  it("LIN-002: attaches the postmortem and p1 labels it resolved", async () => {
    const sdk = workingSdk();
    await build(sdk).createPostmortemDraft("inc-1", "t", "body", undefined, undefined, DATE);

    const args = (sdk.createIssue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.labelIds).toEqual(["lbl-1", "lbl-1"]);
    expect(args.teamId).toBe("team-1");
    expect(args.projectId).toBe("proj-1");
  });

  it("LIN-003: creates a label that does not exist yet", async () => {
    const sdk = workingSdk({ issueLabels: vi.fn().mockResolvedValue({ nodes: [] }) });
    await build(sdk).createPostmortemDraft("inc-1", "t", "body", undefined, undefined, DATE);

    expect(sdk.createIssueLabel).toHaveBeenCalled();
    const args = (sdk.createIssue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.labelIds).toEqual(["lbl-2", "lbl-2"]);
  });

  it("LIN-004: still files the postmortem when labelling fails entirely", async () => {
    // A label is metadata. Losing it must not cost the IC the postmortem
    // issue, which is the artefact the SLA is measured against.
    const sdk = workingSdk({
      issueLabels: vi.fn().mockRejectedValue(new Error("Linear labels down")),
      createIssueLabel: vi.fn().mockRejectedValue(new Error("Linear labels down")),
    });

    const draft = await build(sdk).createPostmortemDraft(
      "inc-1",
      "t",
      "body",
      undefined,
      undefined,
      DATE,
    );

    expect(draft.linear_issue_id).toBe("iss-1");
    const args = (sdk.createIssue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.labelIds).toBeUndefined();
  });

  it("LIN-005: omits the assignee rather than inventing one", async () => {
    // No IC user id means unassigned. Assigning the API token's own viewer
    // would put the postmortem on whoever owns the integration.
    const sdk = workingSdk();
    await build(sdk).createPostmortemDraft("inc-1", "t", "body", undefined, undefined, DATE);

    const args = (sdk.createIssue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.assigneeId).toBeUndefined();
    expect(sdk.createIssue).toHaveBeenCalledTimes(1);
  });

  it("LIN-006: raises when Linear accepts the call but returns no issue", async () => {
    // The caller flips the incident to RESOLVED and tells the IC what landed.
    // A silent success here would report a postmortem that does not exist.
    const sdk = workingSdk({ createIssue: vi.fn().mockResolvedValue({ issue: null }) });

    await expect(
      build(sdk).createPostmortemDraft("inc-1", "t", "body", undefined, undefined, DATE),
    ).rejects.toThrow(/no issue field/);
  });

  it("LIN-007: propagates a Linear outage to the caller", async () => {
    const sdk = workingSdk({ createIssue: vi.fn().mockRejectedValue(new Error("Linear 503")) });

    await expect(
      build(sdk).createPostmortemDraft("inc-1", "t", "body", undefined, undefined, DATE),
    ).rejects.toThrow(/Linear 503/);
  });
});
