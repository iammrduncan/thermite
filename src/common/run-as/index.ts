/**
 * Advisor programs as users of their own (core/advisor-runs.ts): the root helper that runs them
 * (server.ts) and the supervisor's side of it (client.ts). Nothing starts the helper yet: the
 * supervisor's containers, its advisors' calls and the isolation check come next, as goal 172
 * records.
 */

export { RunAsClient, type RunAsRequest } from "./client.ts";
export { RunAsServer, type RunAsServerOptions } from "./server.ts";
