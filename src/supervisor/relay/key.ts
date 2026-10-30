import { createPrivateKey, createPublicKey } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createUser, fromSeed } from "@nats-io/nkeys";
import { log } from "../../common/env.ts";
import { writeAtomic } from "../../common/fs.ts";
import { newSealKey, type SealKey, sealKeyFingerprint } from "../../core/link/config.ts";
import { isUserKey, userKeyFingerprint } from "../../core/link/users.ts";
import { publicKeyLine } from "../../core/tunnel.ts";

/**
 * The rig's own keys on the message bus (goal 168): a NATS user key the supervisor makes the first
 * time it starts with the bus, and keeps in its state folder, and beside it a seal key, which
 * control seals the rig's config to. It signs in with the first and opens its config with the
 * second; control learns both public parts from the registration over HTTPS at the supervisor's
 * start (register.ts), and gives the rig a user that may do only what a rig may. Neither secret part leaves its file: it is not logged,
 * and not sent anywhere.
 */

/** The file in the supervisor's state folder that holds the key's seed. A full reset keeps it. */
export const BUS_KEY_FILE = "bus-key.seed";
/** The file beside it that holds the seal key's private part (PEM). A full reset keeps it. */
export const SEAL_KEY_FILE = "bus-seal.pem";

/** The rig's keys: the seed to sign in with and its public part, and the seal key. */
export interface BusKey {
  seed: Uint8Array;
  publicKey: string;
  seal: SealKey;
}

/**
 * The rig's key, from `home`; made there first, with mode 0600, when there is none. A file that
 * does not hold a user key's seed stops the supervisor, with what to do.
 */
export function busKey(home: string): BusKey {
  const path = join(home, BUS_KEY_FILE);
  if (!existsSync(path)) {
    const made = createUser();
    writeAtomic(path, `${new TextDecoder().decode(made.getSeed())}\n`, 0o600);
    log("supervisor", "made the rig's key on the bus", {
      fingerprint: userKeyFingerprint(made.getPublicKey()),
    });
  }
  chmodSync(path, 0o600);
  const seed = new TextEncoder().encode(readFileSync(path, "utf8").trim());
  let publicKey = "";
  try {
    publicKey = fromSeed(seed).getPublicKey();
  } catch {
    publicKey = "";
  }
  if (!isUserKey(publicKey))
    throw new Error(
      `${path} does not hold a NATS user key's seed: delete it, and the supervisor makes a new key at its next start (control records the change)`,
    );
  return { seed, publicKey, seal: sealKey(home) };
}

/**
 * The rig's seal key, from `home`; made there first, with mode 0600, when there is none. A file
 * that does not hold an X25519 private key stops the supervisor, with what to do.
 */
function sealKey(home: string): SealKey {
  const path = join(home, SEAL_KEY_FILE);
  if (!existsSync(path)) {
    const made = newSealKey();
    writeAtomic(path, made.privatePem, 0o600);
    log("supervisor", "made the rig's seal key for its config on the bus", {
      fingerprint: sealKeyFingerprint(made.publicKey),
    });
  }
  chmodSync(path, 0o600);
  const privatePem = readFileSync(path, "utf8");
  try {
    const key = createPrivateKey(privatePem);
    if (key.asymmetricKeyType === "x25519")
      return {
        privatePem,
        publicKey: publicKeyLine(
          createPublicKey(key).export({ type: "spki", format: "pem" }).toString(),
        ),
      };
  } catch {
    // Said below.
  }
  throw new Error(
    `${path} does not hold an X25519 private key: delete it, and the supervisor makes a new seal key at its next start (control records the change)`,
  );
}

/**
 * The rig's keys as its registration carries them to control (register.ts): the public parts
 * alone, never a secret one.
 */
export function busKeyFigure(key: BusKey): { bus_key: string; bus_seal_key: string } {
  return { bus_key: key.publicKey, bus_seal_key: key.seal.publicKey };
}
