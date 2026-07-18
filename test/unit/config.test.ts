/**
 * Unit tests for the zod-validated env config.
 * Defaults must hold with a bare environment; explicit env vars must win.
 */

describe("config", () => {
  afterEach(() => {
    delete process.env.BEDROCK_SONNET_MODEL_ID;
    delete process.env.BEDROCK_HAIKU_MODEL_ID;
    vi.resetModules();
  });

  it("CFG-001: applies the Bedrock model ID defaults when env vars are unset", async () => {
    const { config } = await import("../../src/config/index.js");
    expect(config.BEDROCK_SONNET_MODEL_ID).toBe("anthropic.claude-sonnet-4-6");
    expect(config.BEDROCK_HAIKU_MODEL_ID).toBe("anthropic.claude-haiku-4-5-20251001-v1:0");
  });

  it("CFG-002: env vars override the defaults", async () => {
    vi.resetModules();
    process.env.BEDROCK_SONNET_MODEL_ID = "us.anthropic.claude-sonnet-4-6";
    process.env.BEDROCK_HAIKU_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
    const { config } = await import("../../src/config/index.js");
    expect(config.BEDROCK_SONNET_MODEL_ID).toBe("us.anthropic.claude-sonnet-4-6");
    expect(config.BEDROCK_HAIKU_MODEL_ID).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
  });
});
