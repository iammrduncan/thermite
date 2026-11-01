/**
 * Each agent's model on a rig: what Edit rig and its twins over REST and MCP share, the request,
 * its checks of shape and the answer (request.ts); Edit rig's own code, which sets and clears a
 * model and checks it (agents.ts); and the routes control sends the rig's agents, each with its
 * key (routes.ts).
 */
export * from "./agents.ts";
export * from "./request.ts";
export * from "./routes.ts";
