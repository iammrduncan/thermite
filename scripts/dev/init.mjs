#!/usr/bin/env node
// Creates .dev/ for local compose runs: random tokens, inbox and outbox. Idempotent.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), ".dev");
const secrets = join(root, "secrets");
for (const d of [
  secrets,
  join(root, "inbox", "repos"),
  join(root, "inbox", "models"),
  join(root, "outbox"),
  // Advisor configuration and keys for local runs (mounted read-only into the supervisors).
  join(root, "advisors"),
  // Control's backups, which the backup service writes (thermite backup).
  join(root, "backups"),
]) {
  mkdirSync(d, { recursive: true, mode: 0o755 });
}
// .dev/ itself is yours alone, made so or not: no other user of this computer reaches the tokens,
// the inbox or the advisors' keys. The containers mount the folders and files below it, so their
// own users still reach those.
chmodSync(root, 0o700);
// The supervisor fetches sources into the inbox as its own user in its container: on native
// Linux that user is not you, so the inbox is open to it, inside the closed .dev/.
for (const d of [join(root, "inbox"), join(root, "inbox", "repos"), join(root, "inbox", "models")])
  chmodSync(d, 0o777);
const token = () => randomBytes(24).toString("base64url");
const write = (name, value) => {
  const p = join(secrets, name);
  if (!existsSync(p)) writeFileSync(p, value, { mode: 0o644 });
};
write("control-admin-token", token());
// An operating agent's token for control's MCP (it may steer and message agents, never approve).
write("control-operator-token", token());
// Rig 1 (always) and rig 2 (the compose "two-rigs" profile). Each has a harness<->supervisor
// token and a proposer token, and a token for control, empty until the stack's enroll step
// enrolls the rig with control and writes it there.
write("control-rig-token", "");
write("control-rig-token-2", "");
write("harness-supervisor-token", token());
write("harness-proposer-token", token());
write("harness2-supervisor-token", token());
write("harness2-proposer-token", token());
// A local model route's key: a placeholder to replace for a real OpenAI-compatible endpoint.
write("model-api-key", "local-placeholder");
console.log(`dev-init: ${root} ready`);
