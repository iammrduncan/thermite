// Control for the browser acceptance check (scripts/acceptance/browser.mjs): the real API and
// dashboard, in this process, on the dashboard demo's made-up data (tests/helpers/demo/), with:
//
// - one more rig, rig-browser, a CPU rig that reports its hardware every 30 seconds, so the
//   New campaign page can start runs on it;
// - the kits control writes itself, so a kit described on the page is kept;
// - a project lookup that answers for any repository under https://git.example.com/ with a fixed
//   commit, and reaches no network.
//
// Control's store is on the tests' fake message bus, as the demo's is: no NATS server, no rig
// processes. A run that New campaign starts is signed and queued for its rig, which never takes it.
//
//   node --experimental-strip-types tests/stand-ins/dashboard/main.ts [--port 0]
//
// It prints one JSON line when it listens: {"url", "token", "db", "commit", "pages"}: control's
// address, the owner's token (new at each start), its store, the commit every project is looked up
// at, and the dashboard's GET routes under /ui as the router has them.

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { newToken } from "../../../src/common/secrets.ts";
import { createControlApi } from "../../../src/control/api/index.ts";
import { mountDashboard } from "../../../src/control/dashboard/index.ts";
import { KitRepos } from "../../../src/control/kits/index.ts";
import { generateSigningKeys } from "../../../src/core/commands.ts";
import { controlStore, ingestReport } from "../../helpers/control-store.ts";
import { seedDemo } from "../../helpers/demo/index.ts";

/** The commit the project lookup gives every repository under PROJECTS. */
const PROJECT_COMMIT = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";
const PROJECTS = "https://git.example.com/";
const RIG = "rig-browser";

const { values } = parseArgs({ options: { port: { type: "string", default: "0" } } });
const dir = mkdtempSync(join(tmpdir(), "thermite-browser-"));
const db = join(dir, "control.db");
const store = controlStore(db);
const keys = generateSigningKeys();
const { token } = newToken();
await seedDemo(store, Date.now(), keys.privateKeyPem);

// rig-browser's report: a CPU rig with nothing at work, seen now.
const next = 0;
const report = async () => {
  await ingestReport(store, {
    rig: RIG,
    ledger_id: `ledger-${RIG}`,
    cursor: next,
    next,
    events: [],
    summary: {
      jobs: {},
      hardware: {
        collected_at: new Date().toISOString(),
        target: { type: "cpu", class: "generic-cpu", id: "cpu-browser" },
        device_mode: "none",
        devices: [],
        cpu: { model: "Example CPU", host: 8, usable: 8, quota: null },
        memory: { host_mib: 16_000, limit_mib: null },
        disks: [],
        os: { kernel: "6.8", arch: "x64", node: "v22", image: null },
        toolchain: { cc: "cc 12", nvcc: null },
        errors: [],
      },
    },
    generated_at: new Date().toISOString(),
  });
};
await report();
setInterval(
  () => void report().catch((err) => console.error(`rig-browser's report: ${err}`)),
  30_000,
).unref();

const app = await createControlApi(store, { admin: token }, keys.privateKeyPem, {
  staleAfterMs: 180_000,
  pages: mountDashboard,
  kits: new KitRepos(join(dir, "kits")),
  probeRepo: async (url, _ref, _access, folder) => {
    if (!url.startsWith(PROJECTS))
      throw new Error(
        `the browser check's control reaches no network: use a repository under ${PROJECTS}`,
      );
    return folder
      ? { commit: PROJECT_COMMIT, files: 3, suggest: [`${folder}/**`] }
      : { commit: PROJECT_COMMIT, files: 3, suggest: ["src/**"] };
  },
});
// The dashboard's pages as the router has them, for the sweep to sample each kind of page.
const pages = [
  ...new Set(
    app.routes.filter((r) => r.method === "GET" && r.path.startsWith("/ui")).map((r) => r.path),
  ),
];
const server = serve({
  fetch: app.fetch,
  hostname: "127.0.0.1",
  port: Number(values.port),
});
server.once("listening", () => {
  const { port } = server.address() as AddressInfo;
  console.log(
    JSON.stringify({ url: `http://127.0.0.1:${port}`, token, db, commit: PROJECT_COMMIT, pages }),
  );
});
// Its store and kits go with it.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
