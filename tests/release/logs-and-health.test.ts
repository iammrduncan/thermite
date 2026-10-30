import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { HEALTH_URLS, healthProbe } from "../../src/core/health.ts";

/**
 * The compose stack and the release bundle bound their logs and check their parts' health (goal
 * 173): in the repository's compose.yaml and in the release bundle's template, each service that
 * runs until stopped names the bounded `json-file` driver and a health check, the one the
 * machines' units run (`healthProbe` on the part's health route), so `docker compose ps` says when
 * a part is unhealthy. The services that run once and end bound their logs too.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** Each part's health route, by service; the bus's server answers on its own monitoring port. */
const ROUTES: Record<string, string> = {
  control: HEALTH_URLS.control,
  harness: HEALTH_URLS.harness,
  "harness-2": HEALTH_URLS.harness,
  supervisor: HEALTH_URLS.supervisor,
  "supervisor-2": HEALTH_URLS.supervisor,
};

/** Each service of a compose file, by name, with its lines (services are two spaces in). */
function services(compose: string): Map<string, string> {
  const found = new Map<string, string>();
  const lines = compose.split("\n");
  let name: string | undefined;
  for (const line of lines.slice(lines.indexOf("services:") + 1)) {
    // The next top-level key ends the services; a comment does not.
    if (/^[^\s#]/.test(line)) break;
    const start = /^ {2}([a-z0-9-]+):$/.exec(line);
    if (start) name = start[1];
    if (name) found.set(name, `${found.get(name) ?? ""}${line}\n`);
  }
  return found;
}

const runsOnce = (service: string) => /^ {4}restart: "no"$/m.test(service);

describe("compose's logs and health checks (goal 173)", () => {
  for (const file of ["compose.yaml", "containers/release/compose.template.yaml"]) {
    test(`${file}: each service that runs until stopped bounds its log and checks its health route`, () => {
      const compose = read(file);
      assert.match(
        compose,
        /^x-logging: &logging\n {2}driver: json-file\n {2}options: \{ max-size: "50m", max-file: "3" \}$/m,
      );
      const all = services(compose);
      const long = [...all].filter(([, s]) => !runsOnce(s));
      assert.deepEqual(
        long.map(([name]) => name),
        ["control", "nats", "harness", "supervisor", "harness-2", "supervisor-2"],
      );
      for (const [name, s] of long) {
        assert.match(s, /^ {4}restart: unless-stopped$/m, name);
        assert.match(s, /^ {4}logging: \*logging$/m, name);
        assert.match(s, /^ {4}healthcheck:$/m, name);
        const route = ROUTES[name];
        const check = route
          ? `test: ["CMD", "node", "-e", ${JSON.stringify(healthProbe(route))}]`
          : `test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8222/healthz?js-enabled-only=true"]`;
        assert.ok(s.includes(`\n      ${check}\n`), `${name}: ${check}`);
      }
    });
  }

  test("compose.yaml: the services that run once and end bound their logs too", () => {
    const once = [...services(read("compose.yaml"))].filter(([, s]) => runsOnce(s));
    assert.deepEqual(
      once.map(([name]) => name),
      ["nats-init", "backup", "enroll", "enroll-2"],
    );
    for (const [name, s] of once) assert.match(s, /^ {4}logging: \*logging$/m, name);
  });
});
