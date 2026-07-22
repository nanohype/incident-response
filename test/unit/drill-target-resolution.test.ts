/**
 * Unit tests for how `scripts/fire-drill.sh` resolves its webhook target.
 *
 * The drill signs every payload with `incident-response/<env>/grafana/
 * oncall-webhook-hmac`, so the resolved destination has to belong to the same
 * environment the signature does. These tests hold that invariant: a run that
 * would deliver one environment's signed alert to another environment's load
 * balancer must fail before it signs anything.
 *
 * The script derives its repo root from its own path, so each case copies it
 * into a temp directory alongside a purpose-built `chart/` and runs it there.
 * That keeps the fixtures — real hostnames, placeholder hostnames, absent
 * environments — out of the shipped values files, and means the script under
 * test carries no test-only seam.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT = path.resolve(__dirname, "../../scripts/fire-drill.sh");
const BASE_VALUES = path.resolve(__dirname, "../../chart/values.yaml");

/** Hostnames a fork would really deploy — deliberately not `.example.com`. */
const HOSTS = {
  development: "webhook-development.incident.example-corp.io",
  staging: "webhook-staging.incident.example-corp.io",
  production: "webhook.incident.example-corp.io",
} as const;

type Env = keyof typeof HOSTS;

interface Fixture {
  root: string;
  /** Run the drill in this fixture. Returns exit code plus merged output. */
  run(args: string[], env?: NodeJS.ProcessEnv): { code: number; output: string };
}

/**
 * Build a throwaway repo root: the real script, the real base values (so
 * `ingress.path` resolves the way it does in production), and one per-env
 * values file per entry in `hosts`. Omitting an environment from `hosts`
 * leaves that file absent, which is how a fork that has not deployed
 * everywhere looks.
 */
function fixture(hosts: Partial<Record<Env, string>>): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drill-target-"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "chart"));
  fs.copyFileSync(SCRIPT, path.join(root, "scripts/fire-drill.sh"));
  fs.copyFileSync(BASE_VALUES, path.join(root, "chart/values.yaml"));
  for (const [env, host] of Object.entries(hosts)) {
    fs.writeFileSync(path.join(root, `chart/values-${env}.yaml`), `ingress:\n  host: ${host}\n`);
  }

  return {
    root,
    run(args, extraEnv = {}) {
      // Start from a clean environment. Inheriting process.env would let a
      // DRILL_* variable set by another test — or by whoever ran the suite —
      // decide the outcome, which is the exact class of bug under test.
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? root,
        ...extraEnv,
      };
      try {
        const output = execFileSync("bash", [path.join(root, "scripts/fire-drill.sh"), ...args], {
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, output };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    },
  };
}

const deployedEverywhere = () => fixture(HOSTS);

describe("fire-drill.sh target resolution", () => {
  const created: Fixture[] = [];
  const track = (f: Fixture) => {
    created.push(f);
    return f;
  };

  afterAll(() => {
    for (const f of created) fs.rmSync(f.root, { recursive: true, force: true });
  });

  describe("a signature for one environment cannot be delivered to another", () => {
    it("refuses an unscoped DRILL_WEBHOOK_HOST, which would apply to every --env", () => {
      const f = track(deployedEverywhere());
      const { code, output } = f.run(["--env", "production", "--dry-run"], {
        DRILL_WEBHOOK_HOST: HOSTS.staging,
      });

      expect(code).not.toBe(0);
      expect(output).toContain("DRILL_WEBHOOK_HOST is set");
      expect(output).toContain("DRILL_WEBHOOK_HOST_PRODUCTION");
      // Nothing was resolved, so nothing was signed or addressed.
      expect(output).not.toContain(HOSTS.staging);
    });

    it("refuses an unscoped DRILL_WEBHOOK_URL for the same reason", () => {
      const f = track(deployedEverywhere());
      const { code, output } = f.run(["--env", "production", "--dry-run"], {
        DRILL_WEBHOOK_URL: `https://${HOSTS.staging}`,
      });

      expect(code).not.toBe(0);
      expect(output).toContain("DRILL_WEBHOOK_URL is set");
      expect(output).toContain("DRILL_WEBHOOK_URL_PRODUCTION");
    });

    it("refuses --host naming the staging webhook while signing for production", () => {
      const f = track(deployedEverywhere());
      const { code, output } = f.run(["--env", "production", "--host", HOSTS.staging, "--dry-run"]);

      expect(code).not.toBe(0);
      expect(output).toContain("refusing to fire");
      expect(output).toContain("incident-response/production/grafana/oncall-webhook-hmac");
      expect(output).toContain("values-staging.yaml");
    });

    it("refuses --url pointing at the staging webhook while signing for production", () => {
      const f = track(deployedEverywhere());
      const { code, output } = f.run([
        "--env",
        "production",
        "--url",
        `https://${HOSTS.staging}`,
        "--dry-run",
      ]);

      expect(code).not.toBe(0);
      expect(output).toContain("refusing to fire");
      expect(output).toContain("values-staging.yaml");
    });

    it("refuses a scoped variable carrying another environment's host", () => {
      const f = track(deployedEverywhere());
      const { code, output } = f.run(["--env", "production", "--dry-run"], {
        DRILL_WEBHOOK_HOST_PRODUCTION: HOSTS.development,
      });

      expect(code).not.toBe(0);
      expect(output).toContain("refusing to fire");
      expect(output).toContain("values-development.yaml");
    });

    it("still refuses when the collision is only visible through a URL's port and path", () => {
      const f = track(deployedEverywhere());
      const { code, output } = f.run([
        "--env",
        "production",
        "--url",
        `https://${HOSTS.staging}:8443/`,
        "--dry-run",
      ]);

      expect(code).not.toBe(0);
      expect(output).toContain("refusing to fire");
    });
  });

  describe("the values file is the environment's identity", () => {
    it("refuses an override that disagrees with the declared host", () => {
      const f = track(deployedEverywhere());
      const { code, output } = f.run([
        "--env",
        "staging",
        "--host",
        "webhook.someone-elses-zone.io",
        "--dry-run",
      ]);

      expect(code).not.toBe(0);
      expect(output).toContain("refusing to fire");
      expect(output).toContain(HOSTS.staging);
    });

    it("accepts an override that agrees with the declared host", () => {
      const f = track(deployedEverywhere());
      const { code, output } = f.run(["--env", "staging", "--host", HOSTS.staging, "--dry-run"]);

      expect(code).toBe(0);
      expect(output).toContain(`https://${HOSTS.staging}/webhook/grafana-oncall`);
    });

    it("allows an override when that environment ships only the placeholder", () => {
      // A fork that has deployed staging but not production: there is no
      // production identity to contradict, so a scoped variable is how the
      // target is named. The cross-environment check still applies.
      const f = track(fixture({ staging: HOSTS.staging, production: "webhook.example.com" }));
      const { code, output } = f.run(["--env", "production", "--dry-run"], {
        DRILL_WEBHOOK_HOST_PRODUCTION: HOSTS.production,
      });

      expect(code).toBe(0);
      expect(output).toContain(`https://${HOSTS.production}/webhook/grafana-oncall`);
    });

    it("refuses to fire at the shipped placeholder", () => {
      const f = track(fixture({ staging: "webhook-staging.example.com" }));
      const { code, output } = f.run(["--env", "staging", "--dry-run"]);

      expect(code).not.toBe(0);
      expect(output).toContain("placeholder host");
    });
  });

  describe("--print-host", () => {
    it("prints the resolved host and nothing else", () => {
      const f = track(deployedEverywhere());
      const { code, output } = f.run(["--env", "production", "--print-host"]);

      expect(code).toBe(0);
      expect(output.trim()).toBe(HOSTS.production);
    });

    it("exits non-zero rather than printing a cross-environment host", () => {
      const f = track(deployedEverywhere());
      const { code, output } = f.run([
        "--env",
        "production",
        "--host",
        HOSTS.staging,
        "--print-host",
      ]);

      expect(code).not.toBe(0);
      expect(output).not.toContain(`${HOSTS.staging}\n`);
    });

    it("resolves each environment to its own host", () => {
      const f = track(deployedEverywhere());
      for (const env of Object.keys(HOSTS) as Env[]) {
        const { code, output } = f.run(["--env", env, "--print-host"]);
        expect(code).toBe(0);
        expect(output.trim()).toBe(HOSTS[env]);
      }
    });
  });
});
