import assert from "node:assert/strict";
import type { RigView } from "../../../../src/control/views/index.ts";
import type { HarnessService } from "../../../../src/harness/service/index.ts";
import { ask } from "../../../../src/supervisor/ask.ts";
import { controlStack, SUPERVISOR_TOKEN, signIn } from "../../../helpers/control-stack.ts";
import type { Form } from "./page.ts";

/**
 * Live's message box and the run page's Experiments and Planner tabs, driven as a browser drives
 * them: each form the page draws is read from its HTML and posted with what a person would type
 * or tick (the drag sends the request the dashboard's script sends). The commands reach a real
 * harness through the supervisor's relay; its events and live lines come back the same way, and
 * the pages are read again. No browser runs: the script only shows and hides what the server drew.
 */

/** Control with one rig (rig-a) whose harness is `env`'s; the supervisor's relay is called directly. */
export async function stack(env: { service: HarnessService; keys: { privateKeyPem: string } }) {
  const { store, control, harness, bus, relay, live, api } = controlStack({ env });
  /**
   * Two passes of the supervisor's relay: control's commands reach the harness, then the events
   * they caused and the harness's new live lines reach control.
   */
  const sync = async () => {
    for (let i = 0; i < 2; i++) {
      await relay();
      await live();
    }
  };
  const session = await signIn(control);
  const get = async (path: string) => {
    const r = await session.get(path);
    assert.equal(r.status, 200, path);
    return r.text();
  };
  const post = session.post;
  /** A form as the page drew it, posted with what the person typed or chose (`set`). */
  const submit = async (f: Form, set: Record<string, string> = {}) => {
    const r = await post(f.action, { ...f.fields, ...set });
    assert.equal(r.status, 303, await r.clone().text());
    return decodeURIComponent(r.headers.get("location") ?? "");
  };
  /** The run as control's records hold it (the owner's REST view of the rig). */
  const run = async (id: string) => {
    const v = (await (await api("GET", "/v1/rigs/rig-a/view")).json()) as RigView;
    const r = v.runs.find((x) => x.id === id);
    assert.ok(r, `control has run ${id}`);
    return r;
  };
  /** A call the supervisor makes to its harness (its own token). */
  const toHarness = (path: string, body: unknown) =>
    harness.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${SUPERVISOR_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  /** The supervisor's report of the advisor roles it has set up, in its figures on the bus. */
  const advisorsSetUp = async (roles: {
    teachers: number;
    merged_by: boolean;
    auditor: boolean;
    review_panel: number;
  }) => {
    await relay(0);
    await ask({ rig: "rig-a", bus }, "figures", {
      at: new Date().toISOString(),
      advisors: {
        teacher_runs: 0,
        directive_sets: 0,
        directives: 0,
        audits: 0,
        reviews: 0,
        errors: 0,
        tokens_in: 0,
        tokens_out: 0,
        usd: 0,
        roles,
      },
    });
  };
  /** The payloads of the commands control signed of one kind, oldest first. */
  const signed = (kind: string) =>
    (
      store.db.prepare("select signed from command where kind = ? order by rowid").all(kind) as {
        signed: string;
      }[]
    ).map((x) => JSON.parse(x.signed).envelope.payload as Record<string, unknown>);
  return { store, sync, get, post, submit, api, run, toHarness, advisorsSetUp, signed };
}
