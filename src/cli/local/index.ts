/**
 * The local compose stack's steps (`thermite local`): its folder, `.dev/`, with its tokens
 * (init.ts), and each rig's enrollment with control at each `up` (enroll.ts).
 */
export * from "./enroll.ts";
export * from "./init.ts";
