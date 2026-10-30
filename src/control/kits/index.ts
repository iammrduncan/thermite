/**
 * The kits control keeps as git repositories and serves to rigs (repos.ts): a kit added as a git
 * bundle (add.ts) or uploaded on the new-campaign page (upload.ts).
 */

export { addKit, kitAnswer, kitsAnswer, MCP_KIT_BASE64_MAX, MCP_KIT_BUNDLE_MAX } from "./add.ts";
export { KIT_BUNDLE_MAX, KitRepos } from "./repos.ts";
export { KIT_ARCHIVE_MAX, kitSummary, unpackKit } from "./upload.ts";
