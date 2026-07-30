/**
 * Unit tests for the zod-validated env config.
 * Defaults must hold with a bare environment; explicit env vars must win.
 */

describe("config", () => {
  afterEach(() => {
    delete process.env.MODEL_ROUTE;
    delete process.env.MODEL_ROUTE_LIGHT;
    vi.resetModules();
  });

  it("CFG-001: applies the model route defaults when env vars are unset", async () => {
    const { config } = await import("../../src/config/index.js");
    expect(config.MODEL_ROUTE).toBe("default");
    expect(config.MODEL_ROUTE_LIGHT).toBe("light");
  });

  it("CFG-002: env vars override the defaults", async () => {
    vi.resetModules();
    process.env.MODEL_ROUTE = "escalation";
    process.env.MODEL_ROUTE_LIGHT = "cheap";
    const { config } = await import("../../src/config/index.js");
    expect(config.MODEL_ROUTE).toBe("escalation");
    expect(config.MODEL_ROUTE_LIGHT).toBe("cheap");
  });
});
