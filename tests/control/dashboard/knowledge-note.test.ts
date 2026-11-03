import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { answerKbAsk } from "../../../src/control/kb/index.ts";
import { assigned } from "../../helpers/assignments.ts";
import { ADMIN, controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { FINDING, fillReader } from "../../helpers/kb-reader.ts";

/**
 * The owner's note (goal 176, item 6): from an item's reader, Add a note keeps a note in the owner
 * slot of the item's run, linked to the item (follows), as the owner; REST, MCP and the command
 * line write it too. The run's agents find it; the reader and the table say "you" wrote it.
 */

const TOKENS = {
  admin: ADMIN,
  operator: "operator-token-abcdef",
  agent: "agent-token-abcdef",
  read: "read-token-abcdef",
  rigs: { "rig-a": "rig-a-token-abcd", "rig-b": "rig-b-token-abcd" },
};
const NOTE = "gemv/gs-1/owner/note:1";

async function stack() {
  const { store, control } = controlOnly({ tokens: TOKENS, options: { staleAfterMs: 600_000 } });
  await fillReader(store);
  assigned(store, "rig-a", "gs-1", "gemv");
  assigned(store, "rig-b", "sv-1", "survey");
  assigned(store, "rig-b", "sv-2", "survey");
  const s = await signIn(control);
  const rest = async (path: string, body: unknown, token = TOKENS.admin) => {
    const r = await control.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { store, control, s, rest };
}

/** The addresses an agent's kb_search of this run finds for these words. */
function agentFinds(store: Parameters<typeof answerKbAsk>[0], rig: string, run: string, q: string) {
  const a = answerKbAsk(store, rig, "search", { run, q });
  assert.ok("hits" in a, JSON.stringify(a));
  return a.hits.map((h) => h.address);
}

describe("the owner's note", () => {
  test("Add a note in the reader keeps it in the run's owner slot, linked to the item; agents find it; you wrote it", async () => {
    const { store, s } = await stack();
    const page = await s.page(`/ui/knowledge/${FINDING}`);
    assert.match(
      page,
      /<details class="kx-sec kx-addnote"><summary>[\s\S]*?<span>Add a note<\/span><\/summary><form method="post" action="\/ui\/kb\/note" class="kx-noteform">/,
    );
    assert.match(
      page,
      /<label class="sfd"><span class="lb">Your note<i class="ii" tabindex="0" data-tip="/,
    );
    assert.match(page, /Saves your note in the owner slot of run gs-1, linked to this item\./);
    // Without the form's token: refused, nothing kept.
    const forged = await s.post("/ui/kb/note", {
      address: FINDING,
      text: "x",
      back: "/ui/knowledge",
    });
    assert.equal(forged.status, 403);
    const csrf = s.csrfOf(page);
    const back = `/ui/knowledge/gemv/gs-1/worker-1?item=${encodeURIComponent(FINDING)}`;
    const saved = await s.post("/ui/kb/note", {
      csrf,
      back,
      address: FINDING,
      text: "Check this on the second device before trusting it: zanzibarite.",
    });
    assert.equal(saved.status, 303);
    const to = String(saved.headers.get("location"));
    assert.ok(to.startsWith(back));
    assert.match(decodeURIComponent(to), new RegExp(`ok=Your note is kept: ${NOTE}`));
    assert.match(
      await s.page(to),
      /<div class="kx-note ok" role="status">Your note is kept: gemv\/gs-1\/owner\/note:1/,
    );
    // Stored in the owner slot, linked to the item, never by an event of a rig.
    const kb = store.kb();
    const note = kb.at(NOTE);
    assert.ok(note);
    assert.equal(note.slot, "owner");
    assert.equal(note.kind, "note");
    assert.equal(note.title, "Check this on the second device before trusting it: zanzibarite.");
    assert.deepEqual(
      kb.versions(note.id).map((v) => [v.version, v.links, v.event]),
      [[1, [{ rel: "follows", to: FINDING }], null]],
    );
    // The run's agents find it, and so do a run's whose scope includes gemv; not one's that leaves it out.
    assert.deepEqual(agentFinds(store, "rig-a", "gs-1", "zanzibarite"), [NOTE]);
    assert.deepEqual(agentFinds(store, "rig-b", "sv-1", "zanzibarite"), [NOTE]);
    assert.deepEqual(agentFinds(store, "rig-b", "sv-2", "zanzibarite"), []);
    // The reader and the table say you wrote it; the item's links say it is followed by the note.
    const reader = await s.page(`/ui/knowledge/${NOTE}`);
    assert.match(
      reader,
      /<span class="mono">owner<\/span><span aria-hidden="true">·<\/span><span>you<\/span>/,
    );
    const table = await s.page("/ui/knowledge/gemv/gs-1/owner");
    assert.match(
      table,
      new RegExp(`<span class="kx-addr">${NOTE}</span>[\\s\\S]*?<td class="c-writer">you</td>`),
    );
    assert.match(
      await s.page("/ui/knowledge/gemv/gs-1"),
      /<a href="\/ui\/knowledge\/gemv\/gs-1\/owner">owner<\/a>[\s\S]*?<td class="c-writer">you<\/td>/,
    );
    assert.match(await s.page(`/ui/knowledge/${FINDING}`), /followed by/);
    // An empty note is refused in words, back on the item.
    const empty = await s.post("/ui/kb/note", { csrf, back, address: FINDING, text: " " });
    assert.match(decodeURIComponent(String(empty.headers.get("location"))), /error=Write the note/);
    assert.match(
      store.auditLog
        .list(200, { action: "kb_note" })
        .map((a) => a.actor)
        .join(),
      /owner:ui/,
    );
  });

  test("REST for the owner, MCP for the owner and an operator (acting for the owner), none for agents", async () => {
    const { store, control, rest } = await stack();
    const r = await rest("/v1/kb/notes", { address: FINDING, text: "First.", title: "A title" });
    assert.equal(r.status, 201);
    assert.equal(r.body.address, NOTE);
    assert.equal(store.kb().at(NOTE)?.title, "A title");
    for (const token of [TOKENS.operator, TOKENS.agent, TOKENS.read])
      assert.notEqual(
        (await rest("/v1/kb/notes", { address: FINDING, text: "x" }, token)).status,
        201,
      );
    const missing = await rest("/v1/kb/notes", {
      address: "gemv/gs-1/worker-1/finding:404",
      text: "x",
    });
    assert.equal(missing.status, 400);
    assert.match(
      String(missing.body.error),
      /the knowledge base has no item gemv\/gs-1\/worker-1\/finding:404/,
    );
    assert.equal((await rest("/v1/kb/notes", { address: FINDING, text: "" })).status, 400);
    const op = await mcpClient(control, TOKENS.operator);
    const out = (await op.callTool({
      name: "kb_note",
      arguments: { address: NOTE, text: "A note on the note." },
    })) as { content: { text: string }[] };
    const b = JSON.parse(String(out.content[0]?.text)) as { address: string; follows: string };
    assert.deepEqual([b.address, b.follows], ["gemv/gs-1/owner/note:2", NOTE]);
    assert.match(
      store.auditLog
        .list(200, { action: "kb_note" })
        .map((a) => a.actor)
        .join(),
      /owner:operator/,
    );
    const agent = await mcpClient(control, TOKENS.agent);
    assert.ok(!(await agent.listTools()).tools.some((t) => t.name === "kb_note"));
  });
});
