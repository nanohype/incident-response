/**
 * Unit tests for the environment helpers.
 *
 * awsRegion is the reason this file exists. Inlined at each SDK client
 * construction it was un-testable in principle: those run at module load, so
 * exactly one arm is taken per process and which one depends on whether the
 * environment exports AWS_REGION — CI does, a developer shell usually does not.
 * A branch whose coverage flips with the runner is not a branch anyone can hold
 * a floor over. Called from here, both arms are reachable in one run.
 *
 * The refusal arm matters more than the accept arm: it is what keeps a
 * misconfigured deploy from addressing an unintended region, so it is asserted
 * on the message and not only on the throw.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  awsRegion,
  REQUIRED_ENV_SHARED,
  REQUIRED_ENV_WEBHOOK,
  requiredEnv,
} from "../../src/utils/env.js";

describe("awsRegion", () => {
  const ORIGINAL = process.env.AWS_REGION;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = ORIGINAL;
  });

  it("uses AWS_REGION when the environment sets it", () => {
    process.env.AWS_REGION = "eu-central-1";
    expect(awsRegion()).toBe("eu-central-1");
  });

  it("refuses to guess a region when it is unset", () => {
    // No default: the region selects the account partition every DynamoDB, SQS,
    // Secrets Manager and Scheduler call lands in, and a wrong guess is a
    // silently misaddressed call rather than a visible failure.
    delete process.env.AWS_REGION;
    expect(() => awsRegion()).toThrow(/AWS_REGION is not set/);
  });

  it("treats an empty region as unset rather than passing it to the SDK", () => {
    // An empty string is not nullish, so `??` would let it through and every
    // SDK client would be constructed against region "", failing later with an
    // error that names the SDK instead of the misconfiguration.
    process.env.AWS_REGION = "";
    expect(() => awsRegion()).toThrow(/AWS_REGION is not set/);
  });
});

describe("requiredEnv", () => {
  const NAME = "INCIDENT_RESPONSE_TEST_ONLY_VAR";

  afterEach(() => {
    delete process.env[NAME];
  });

  it("returns the value when it is set", () => {
    process.env[NAME] = "value";
    expect(requiredEnv(NAME)).toBe("value");
  });

  it("throws naming the variable when it is unset", () => {
    delete process.env[NAME];
    // The name is in the message because the caller is usually a config
    // mistake in a manifest, not a bug in the code that read it.
    expect(() => requiredEnv(NAME)).toThrow(new RegExp(`${NAME} is not set`));
  });

  it("treats an empty value as unset", () => {
    process.env[NAME] = "";
    expect(() => requiredEnv(NAME)).toThrow(new RegExp(`${NAME} is not set`));
  });
});

describe("entrypoint env contracts", () => {
  it("requires the webhook's HMAC secret id on the webhook only", () => {
    // The webhook fetches that secret through its own pod grant; the processor
    // never verifies a Grafana signature and has no such grant.
    expect(REQUIRED_ENV_WEBHOOK).toContain("GRAFANA_ONCALL_HMAC_SECRET_ID");
    expect(REQUIRED_ENV_SHARED).not.toContain("GRAFANA_ONCALL_HMAC_SECRET_ID");
  });

  it("holds the webhook to at least everything the processor requires", () => {
    // The asymmetry this guards against is the one that shipped: the processor
    // validated its environment and the webhook validated nothing, so the
    // webhook booted healthy with a dead Slack surface. Both entrypoints build
    // the same dependency graph, so neither may require less than the other.
    for (const v of REQUIRED_ENV_SHARED) expect(REQUIRED_ENV_WEBHOOK).toContain(v);
  });

  it("names no variable twice", () => {
    expect(new Set(REQUIRED_ENV_WEBHOOK).size).toBe(REQUIRED_ENV_WEBHOOK.length);
  });
});
