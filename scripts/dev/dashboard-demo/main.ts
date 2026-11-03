// A local demo of the control dashboard with synthetic data: the dashboard's demo seed
// (tests/helpers/demo/), which the dashboard's tests read too. Four rigs of a hill climb, a goal
// campaign part way, a research campaign and a stale rig; and three rigs with decisions waiting
// for the owner. For working on the dashboard, and the documentation's screenshots, only.
//
//   node --experimental-strip-types scripts/dev/dashboard-demo/main.ts [--port 8810]
//   then open http://127.0.0.1:8810/ui and sign in with the token it prints.
//
// Control's store is on the tests' fake message bus, in this process: what control derives from
// the rigs' events (model usage, the knowledge base, commands' outcomes) is applied from its
// events stream, as on a real bus, and the demo needs no NATS server.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createControlApi } from "../../../src/control/api/index.ts";
import { mountDashboard } from "../../../src/control/dashboard/index.ts";
import { generateSigningKeys } from "../../../src/core/commands.ts";
import { controlStore } from "../../../tests/helpers/control-store.ts";
import { seedDemo } from "../../../tests/helpers/demo/index.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "8810" } } });

const store = controlStore(join(mkdtempSync(join(tmpdir(), "thermite-demo-")), "control.db"));
const keys = generateSigningKeys();
const tokens = { admin: "demo-admin-token-0123456789" };
await seedDemo(store, Date.now(), keys.privateKeyPem);

const port = Number(values.port);
serve({
  fetch: createControlApi(store, tokens, keys.privateKeyPem, {
    staleAfterMs: 180_000,
    pages: mountDashboard,
  }).fetch,
  hostname: "127.0.0.1",
  port,
});
console.log(`dashboard demo: http://127.0.0.1:${port}/ui  (token: ${tokens.admin})`);
