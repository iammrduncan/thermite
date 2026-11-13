import { setStoreWaits } from "../../src/control/store/waits.ts";

/**
 * Loaded before each test file when the tests run with `--store-waits turn` (scripts/test.mjs):
 * every store a test opens then takes a turn of the event loop for each call, as a store on a
 * server does. A caller that does not wait for an answer, or that relies on nothing happening
 * between two calls, shows there.
 */
setStoreWaits("turn");
