/**
 * Advisor programs as users of their own (core/advisor-runs.ts): the root helper that runs them
 * (server.ts) and the supervisor's side of it (client.ts). The supervisor image's entry
 * (src/supervisor/advisor-runs/main.ts) serves it, and the broker does in the one-container rig
 * image.
 */

export { RunAsClient, type RunAsRequest } from "./client.ts";
export { RunAsServer, type RunAsServerOptions } from "./server.ts";
