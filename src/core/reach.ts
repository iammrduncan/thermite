import { z } from "zod";

/**
 * The addresses cluster rigs' harnesses may reach beside the internet: a list the owner keeps on
 * control, which control writes into the network rules of each rig's harness, and which its check
 * of a slot's rules accepts. Each entry is one address, IPv4 or IPv6, never a range, so it opens
 * one host and none of its neighbours; and the TCP ports the harness reaches it on, with a note
 * of what it is.
 */

/** How many entries the list takes. */
export const REACH_MAX_ENTRIES = 64;
/** How many ports one entry takes. */
export const REACH_MAX_PORTS = 16;
/** The longest note of an entry, in characters. */
export const REACH_NOTE_MAX = 200;

/**
 * One address in the one form control compares and writes: IPv4 as four numbers from 0 to 255
 * with no leading zero, IPv6 as the URL standard writes it (lowercase, its longest run of zeros
 * as ::). Undefined for anything else: a name, a range, a zone, a port.
 */
export function canonicalAddress(text: string): string | undefined {
  const t = text.trim();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(t);
  if (v4) {
    const parts = v4.slice(1);
    return parts.every((p) => Number(p) <= 255 && String(Number(p)) === p)
      ? parts.join(".")
      : undefined;
  }
  if (!t.includes(":") || /[^0-9a-fA-F:.]/.test(t)) return undefined;
  try {
    return new URL(`http://[${t}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
}

/** Whether an address is IPv6: its network rule then names it as /128, else as /32. */
export const isIpv6 = (address: string) => address.includes(":");

/** An address of the shared range, as the words' example. */
const EXAMPLE = "100.64.0.7"; // public-check: allow (an example in a reserved range)

/** What an address that is not one takes, in words. */
const addressWords = (a: string) =>
  a.includes("/")
    ? `"${a}" is a range: give one address, such as ${EXAMPLE}, for each host`
    : `"${a}" is not one IPv4 or IPv6 address, such as ${EXAMPLE} or fd7a:115c:a1e0::7`;

/** One entry of the list: its address in its one form, its ports in order, and its note. */
export const ReachEntry = z.strictObject({
  address: z
    .string()
    .max(64)
    .transform((a, ctx) => {
      const c = canonicalAddress(a);
      if (c === undefined) {
        ctx.addIssue({ code: "custom", message: addressWords(a.trim()) });
        return z.NEVER;
      }
      return c;
    }),
  ports: z
    .array(z.number().int().min(1).max(65535))
    .min(1, "give at least one TCP port")
    .max(REACH_MAX_PORTS, `give at most ${REACH_MAX_PORTS} ports for one address`)
    .transform((ps) => [...new Set(ps)].sort((a, b) => a - b)),
  note: z.string().trim().max(REACH_NOTE_MAX).default(""),
});
export type ReachEntry = z.output<typeof ReachEntry>;

/** The whole list, each address once. */
export const ReachList = z
  .array(ReachEntry)
  .max(REACH_MAX_ENTRIES, `the list takes at most ${REACH_MAX_ENTRIES} addresses`)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const e of list) {
      if (seen.has(e.address))
        ctx.addIssue({
          code: "custom",
          message: `${e.address} is listed twice: give it once, with all its ports`,
        });
      seen.add(e.address);
    }
  });

/** The list as REST and MCP take it and answer it. */
export const ReachBody = z.strictObject({ addresses: ReachList });
