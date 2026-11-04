/**
 * A follower of a rig's leader (goal 205): its judge GPUs, which it builds and measures on for the
 * leader's judge (device.ts), its API (api.ts) and its start (start.ts).
 */

export { followerApi } from "./api.ts";
export { DeviceServer } from "./device.ts";
export { startFollower } from "./start.ts";
