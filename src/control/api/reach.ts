import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { BadInput, jsonBody } from "../../common/errors.ts";
import { REACHABLE_ADDRESSES, SET_REACHABLE_ADDRESSES } from "../../core/api/control/owner.ts";
import { setReachableAddresses } from "../clusters/index.ts";
import type { ApiContext } from "./context.ts";

/**
 * The addresses cluster rigs' harnesses may reach beside the internet (clusters/reach.ts), with the
 * owner's token: the list, and the whole list set anew, refused in the same words as Settings and
 * MCP.
 */
export function reachRoutes(app: Hono, api: ApiContext): void {
  const { parts, store, admin } = api;
  app.get(REACHABLE_ADDRESSES.path, admin, (c) => c.json({ addresses: store.reachable.list() }));
  app.put(
    SET_REACHABLE_ADDRESSES.path,
    admin,
    bodyLimit({ maxSize: SET_REACHABLE_ADDRESSES.maxBytes }),
    async (c) => {
      const body = await jsonBody(c.req);
      const keys = body && typeof body === "object" ? Object.keys(body) : [];
      if (keys.length !== 1 || keys[0] !== "addresses")
        throw new BadInput('the body is {"addresses": [{"address", "ports", "note"}, …]}');
      const r = setReachableAddresses(
        parts,
        (body as { addresses: unknown }).addresses,
        "owner:api",
      );
      if ("error" in r) throw new BadInput(r.error);
      return c.json({ addresses: store.reachable.list(), said: r.ok });
    },
  );
}
