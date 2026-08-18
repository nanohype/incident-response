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
import { awsRegion } from "../../src/utils/env.js";

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
