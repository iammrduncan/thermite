import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RETENTION_TIPS } from "../../../src/control/dashboard/settings/retention.ts";
import { esc } from "../../../src/control/ui/components/index.ts";
import { RETENTION_JS } from "../../../src/control/ui/retention.ts";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";

/**
 * Settings › Retention policies, as the owner approved the mockup: no policy by default (Thermite
 * keeps everything, everywhere); the form with an ⓘ on every label and its If it ran now; a new
 * policy off until turned on; Run now asks first, in the page; and what the policies removed.
 */

const OWNER = "owner-token-abcdef";

/** An audit entry `days` old, for a policy of the audit log to remove. */
function oldEntry(store: ReturnType<typeof controlOnly>["store"], days: number) {
  store.db
    .prepare(
      "insert into audit (at, actor, action, body) values (?, 'owner:api', 'old_thing', '{}')",
    )
    .run(new Date(Date.now() - days * 86_400_000).toISOString());
}

const location = (r: Response) =>
  decodeURIComponent((r.headers.get("location") ?? "").replace(/\+/g, " "));

describe("Settings › Retention policies", () => {
  test("by default: no policy, Space says where each kind is kept and what removes it", async () => {
    const { control } = controlOnly({ tokens: { admin: OWNER } });
    const s = await signIn(control, OWNER);
    // Space and the policies are two areas of Settings (goal 181).
    let html = await s.page("/ui/settings/space");
    assert.match(
      html,
      /<th>Kind<\/th><th>Kept on<\/th><th class="num">Space<\/th><th>Removed by<\/th>/,
    );
    const row = (kind: string) => html.slice(html.indexOf(`data-space="${kind}"`)).slice(0, 1500);
    assert.match(row("builds"), /<td>Rigs<\/td>/);
    assert.match(row("advisor_records"), /<td>Supervisors<\/td>/);
    assert.match(row("builds"), /0 rigs said/);
    assert.match(row("audit"), /Kept for good/);
    assert.match(row("exports"), /By hand, on <a href="\/ui\/exports">Exports<\/a>/);
    assert.match(
      row("copies"),
      /Control keeps the two newest, until a policy for this kind is on\./,
    );
    assert.match(row("trial_logs"), /<td>Rigs<\/td>/);
    assert.match(row("events"), /Kept for good/);
    html = await s.page("/ui/settings/retention");
    assert.match(html, /<b>No policy\. Thermite keeps everything, everywhere\.<\/b>/);
    assert.match(
      html,
      /<a class="btn primary" href="\/ui\/settings\/retention\?retention=new#retention">New policy<\/a>/,
    );
    assert.match(html, /<h2>Never removed by a policy<\/h2>/);
    for (const never of ["Rigs' ledgers", "Results repositories", "Exports"])
      assert.ok(html.includes(`<b>${esc(never)}</b>`), never);
    assert.match(html, /<h2>What policies removed<\/h2>[\s\S]*?Nothing removed yet\./);
    assert.match(html, /<script src="\/ui\/assets\/retention\.js" defer><\/script>/);
  });

  test("New policy: every label has its ⓘ; Save waits for a name; saved off or on", async () => {
    const { control, store } = controlOnly({ tokens: { admin: OWNER } });
    const s = await signIn(control, OWNER);
    const form = await s.page("/ui/settings?retention=new");
    assert.match(form, /<h3>New policy<\/h3>/);
    for (const tip of Object.values(RETENTION_TIPS))
      assert.ok(form.includes(`data-tip="${esc(tip)}"`), tip);
    for (const group of ["Kept on control", "Kept on rigs", "Kept on supervisors"])
      assert.ok(form.includes(`<optgroup label="${group}">`), group);
    assert.match(form, /<option value="builds" selected>Judge's builds — 0 B<\/option>/);
    assert.match(
      form,
      /<button class="primary" name="save" value="on" disabled title="Give it a name first">Save and turn on<\/button>/,
    );
    assert.match(form, /id="rt-preview"><b data-big>It would remove nothing now\.<\/b>/);
    assert.match(form, /id="rt-first">Turned on, it first runs (today|tomorrow) at 03:00 UTC\.</);
    // Control's copy of the rigs' events is kept on control, and says where by rig; its warning.
    assert.match(form, /<option value="events">Rigs' events \(control's copy\) — /);
    assert.match(form, /removed events leave it then, and can(&#39;|')t be shown again/);
    assert.match(form, /<option value="trial_logs">Trials' session logs — /);
    // The audit log's kind carries its warning.
    assert.ok(
      form.includes("Entries removed can&#39;t be shown again") ||
        form.includes("Entries removed can't be shown again"),
    );
    const csrf = s.csrfOf(form);

    const off = await s.post("/ui/settings/retention", {
      csrf,
      name: "Old audit",
      kind: "audit",
      rule: "older",
      older_n: "30",
      older_unit: "days",
      when: "weekly",
      day: "sunday",
      time: "04:30",
      save: "off",
    });
    assert.equal(off.status, 303);
    assert.match(location(off), /ok=Saved “Old audit”, off\./);
    const [p] = store.retention.list();
    assert.equal(p?.on, false, "Save, off");
    assert.equal(p?.when, "weekly");
    const html = await s.page("/ui/settings/retention");
    const row = html.slice(html.indexOf(`data-policy="${p?.id}"`)).slice(0, 3000);
    assert.match(row, /<b>Old audit<\/b><div class="muted small">Audit log<\/div>/);
    assert.match(row, /<td>control<\/td><td>Removes older than 30 days<\/td>/);
    assert.match(row, /<span class="muted">off<\/span>/);
    assert.match(row, /never ran/);
    assert.match(row, /data-autosubmit aria-label="Turn Old audit on or off"/);

    const on = await s.post("/ui/settings/retention", {
      csrf,
      name: "Old builds",
      kind: "builds",
      where: "all",
      rule: "newest",
      newest_n: "20",
      newest_per: "rig",
      keep_champions: "1",
      keep_open: "1",
      when: "daily",
      time: "03:00",
      save: "on",
    });
    assert.match(location(on), /Saved “Old builds” and turned it on\./);
    const builds = store.retention.list().find((x) => x.name === "Old builds");
    assert.equal(builds?.on, true);
    assert.deepEqual(builds?.keep, { open: true, champions: true, newest: false });

    // The switch turns one on or off at once; Edit opens the form with what it holds.
    await s.post(`/ui/settings/retention/${p?.id}/on`, { csrf, on: "1" });
    assert.equal(store.retention.get(p?.id ?? 0)?.on, true);
    await s.post(`/ui/settings/retention/${p?.id}/on`, { csrf });
    assert.equal(store.retention.get(p?.id ?? 0)?.on, false);
    const edit = await s.page(`/ui/settings?retention=edit&policy=${p?.id}`);
    assert.match(edit, /<h3>Edit policy<\/h3>/);
    assert.match(edit, /name="name" maxlength="80" value="Old audit"/);
    assert.match(edit, new RegExp(`<input type="hidden" name="policy" value="${p?.id}">`));
    assert.match(edit, /<option value="weekly"|value="weekly" checked/);
  });

  test("each kind's words for what it keeps reach the page's script whole, apostrophes too", async () => {
    // The words sat in a single-quoted attribute, so "Each lane's champion builds" ended it at the
    // apostrophe: the script's JSON.parse threw on every change, before Save could wait for a
    // name, and Save stayed off. Read as a browser reads an attribute, in either quote.
    const { control } = controlOnly({ tokens: { admin: OWNER } });
    const s = await signIn(control, OWNER);
    const form = await s.page("/ui/settings?retention=new");
    const attrs = [...form.matchAll(/data-keep-words=(?:"([^"]*)"|'([^']*)')/g)].map((m) =>
      (m[1] ?? m[2] ?? "")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
    );
    assert.ok(attrs.length > 0, "the form names what each kind keeps");
    const words = attrs.flatMap((a) => Object.values(JSON.parse(a) as Record<string, string>));
    assert.ok(words.includes("Each lane's champion builds"), words.join(" | "));
  });

  test("a refused design comes back to the form with what was typed, and says why", async () => {
    const { control, store } = controlOnly({ tokens: { admin: OWNER } });
    const s = await signIn(control, OWNER);
    const csrf = s.csrfOf(await s.page("/ui/settings?retention=new"));
    const bad = await s.post("/ui/settings/retention", {
      csrf,
      name: "Too small",
      kind: "audit",
      rule: "older",
      older_n: "0",
      save: "on",
    });
    const to = bad.headers.get("location") ?? "";
    assert.match(location(bad), /error=not a retention policy: older_n/);
    assert.equal(store.retention.list().length, 0);
    const again = await (await s.get(to)).text();
    assert.match(again, /<b class="bad">Not done\.<\/b>/);
    assert.match(again, /value="Too small"/, "what was typed stays");
  });

  test("Run now asks first, in the page, saying what it removes; Remove now removes it and lists it", async () => {
    const { control, store } = controlOnly({ tokens: { admin: OWNER } });
    oldEntry(store, 40);
    oldEntry(store, 45);
    const s = await signIn(control, OWNER);
    const csrf = s.csrfOf(await s.page("/ui/settings"));
    await s.post("/ui/settings/retention", {
      csrf,
      name: "Old audit",
      kind: "audit",
      rule: "older",
      older_n: "30",
      save: "off",
    });
    const [p] = store.retention.list();
    const list = await s.page("/ui/settings/retention");
    assert.match(
      list,
      new RegExp(
        `href="/ui/settings/retention\\?retention=run&amp;policy=${p?.id}#retention">Run now</a>`,
      ),
    );
    assert.match(list, /would remove now: \d+ B/);
    assert.doesNotMatch(list, /id="rt-confirm"/, "nothing asked before Run now");

    const ask = await s.page(`/ui/settings?retention=run&policy=${p?.id}`);
    const card =
      /<div class="rt-confirm" id="rt-confirm">[\s\S]*?<\/div><\/div>/.exec(ask)?.[0] ?? "";
    assert.match(card, /<b>Run “Old audit” now\?<\/b>/);
    assert.match(
      card,
      /It removes 2 entries, \d+ B, from \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d\. This can't be undone\./,
    );
    assert.match(card, new RegExp(`action="/ui/settings/retention/${p?.id}/run"`));
    assert.match(card, /<button class="danger solid">Remove now<\/button>/);
    assert.match(card, /<a class="btn" href="\/ui\/settings\/retention">Cancel<\/a>/);
    assert.equal(
      store.auditLog.list(100).filter((a) => a.action === "old_thing").length,
      2,
      "asking removes nothing",
    );

    const done = await s.post(`/ui/settings/retention/${p?.id}/run`, { csrf });
    assert.match(location(done), /ok=“Old audit” removed 2 entries/);
    assert.equal(store.auditLog.list(100).filter((a) => a.action === "old_thing").length, 0);
    const after = await s.page("/ui/settings/retention");
    assert.match(
      after,
      /<tr data-removal="\d+"><td class="nowrap">[^<]+ UTC<\/td><td>Old audit<\/td><td>2 entries, [^<]+ on control<\/td><td class="num">[^<]+<\/td><td>you, Run now<\/td><\/tr>/,
    );
    const row = after.slice(after.indexOf(`data-policy="${p?.id}"`)).slice(0, 3000);
    assert.match(row, /removed \d+ B/, "its last run");

    // Delete: the policy goes; what it removed stays.
    await s.post(`/ui/settings/retention/${p?.id}/delete`, { csrf });
    assert.equal(store.retention.list().length, 0);
    assert.match(await s.page("/ui/settings/retention"), /<td>Old audit<\/td>/);
  });

  test("If it ran now follows the form: the page's script asks control as the design changes", async () => {
    const { control, store } = controlOnly({ tokens: { admin: OWNER } });
    oldEntry(store, 40);
    const s = await signIn(control, OWNER);
    const csrf = s.csrfOf(await s.page("/ui/settings?retention=new"));
    const ask = async (fields: Record<string, string>) =>
      (await (
        await s.post(
          "/ui/settings/retention/preview",
          { csrf, ...fields },
          { accept: "application/json" },
        )
      ).json()) as Record<string, unknown>;
    const some = await ask({ kind: "audit", rule: "older", older_n: "30" });
    assert.match(String(some.words), /^It would remove 1 entry, /);
    assert.match(String(some.first), /^Turned on, it first runs/);
    const none = await ask({ kind: "audit", rule: "older", older_n: "90" });
    assert.equal(none.words, "It would remove nothing now.");
    assert.equal(none.stays, "Everything it covers is inside the rule today.");
    const bad = await ask({ kind: "audit", rule: "older", older_n: "x" });
    assert.match(String(bad.error), /^not a retention policy/);
    assert.equal(store.retention.list().length, 0, "a preview saves nothing");
  });

  test("the page's script parses, and asks with no browser dialog", () => {
    assert.doesNotThrow(() => new Function(RETENTION_JS));
    assert.doesNotMatch(RETENTION_JS, /\bconfirm\(|\balert\(|\bprompt\(/);
  });
});
