/**
 * Thermite's git: one runner, with a named time limit (run.ts), and the access to a private
 * repository, an SSH deploy key or an HTTPS token, that runs git through it (auth.ts).
 */
export * from "./auth.ts";
export * from "./run.ts";
