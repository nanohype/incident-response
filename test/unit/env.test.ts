/**
 * Unit tests for the environment helpers.
 *
 * awsRegion's fallback is the reason this file exists. Inlined at each SDK client
 * construction it was un-testable in principle: those run at module load, so
 * exactly one arm is taken per process and which one depends on whether the
 * environment exports AWS_REGION — CI does, a developer shell usually does not.
 * A branch whose coverage flips with the runner is not a branch anyone can hold
 * a floor over. Called from here, both arms are reachable in one run.
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

  it("falls back to us-east-1 when it is unset", () => {
    delete process.env.AWS_REGION;
    expect(awsRegion()).toBe("us-east-1");
  });

  it("falls back rather than passing an empty region to the SDK", () => {
    // An empty string is not nullish, so `?? ` would let it through and every
    // SDK client would be constructed against region "". Treat it as unset.
    process.env.AWS_REGION = "";
    expect(awsRegion()).toBe("us-east-1");
  });
});
