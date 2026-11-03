import { makeCa } from "../../src/control/bus/cert.ts";

/**
 * A certificate of an authority for the message bus, as control keeps its own: what a launch on
 * RunPod gives a pod to trust control's server through (control/bus/leaf.ts). Control launches no
 * pod without one.
 */
export const TEST_BUS_CA = makeCa(new Date(), 1, "Thermite: a test's bus authority").cert;
