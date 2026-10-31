import type { Hono } from "hono";
import { errorText } from "../../../common/errors.ts";
import {
  CHECK_SCRIPT,
  type MachineFacts,
  missing,
  parseFacts,
  RECIPES,
  type RecipeId,
  recipeScript,
  scriptSha,
} from "../../machines/index.ts";
import type { Dashboard } from "../context.ts";
import { machineUrl } from "./shared.ts";

/**
 * A machine's forms on Providers: read and trust its host key, check it, install what it lacks
 * or decline it, and delete it.
 */
export function machineRoutes(app: Hono, dash: Dashboard): void {
  const { noted, opts, parts, ssh, store } = dash;

  // ---------------------------------------------------------------- machines (Providers)
  /** Reads the machine's facts now (read-only), and keeps them or why it could not. */
  const checkMachine = async (name: string): Promise<string | null> => {
    const m = store.machines.get(name);
    if (!m) return "no such machine";
    try {
      const r = await ssh.sshScript(
        {
          address: m.address,
          port: m.port,
          user: m.user,
          privateKey: opts.secrets.open(m.key_sealed),
          hostKeys: m.host_keys,
        },
        CHECK_SCRIPT,
        [parts.publicUrl ? `${parts.publicUrl.replace(/\/$/, "")}/v1/health` : ""],
        60_000,
      );
      if (r.code !== 0)
        throw new Error(`the check exited ${r.code}: ${r.stderr.trim().split("\n").pop() ?? ""}`);
      store.machines.setFacts(name, { facts: parseFacts(r.stdout) });
      return null;
    } catch (err) {
      const why = errorText(err);
      store.machines.setFacts(name, { error: why });
      // A changed host key: read what it presents now, for the owner to compare.
      if (/different host key/.test(why))
        await ssh
          .scanHostKeys(m.address, m.port)
          .then((keys) =>
            store.machines.seeHostKeys(
              name,
              keys.map((k) => k.line),
            ),
          )
          .catch(() => {});
      return why;
    }
  };
  app.post("/ui/settings/machines/:name/scan", async (c) => {
    const m = store.machines.get(c.req.param("name"));
    if (!m) return c.redirect(machineUrl("error", "No such machine."), 303);
    const keys = await ssh.scanHostKeys(m.address, m.port).catch(() => []);
    store.machines.seeHostKeys(
      m.name,
      keys.map((k) => k.line),
    );
    return c.redirect(
      keys.length
        ? machineUrl("ok", `Read "${m.name}"'s host key: compare it below.`)
        : machineUrl("error", `No SSH server answered at ${m.address} port ${m.port}.`),
      303,
    );
  });
  // The owner trusts exactly the keys they were shown (the form carries them back).
  app.post("/ui/settings/machines/:name/trust", async (c) => {
    const m = store.machines.get(c.req.param("name"));
    const seen = String((await c.req.parseBody()).seen ?? "");
    if (!m) return c.redirect(machineUrl("error", "No such machine."), 303);
    if (!m.seen_host_keys.length || seen !== m.seen_host_keys.join("\n"))
      return c.redirect(
        machineUrl("error", "The host key changed since the page showed it: compare it again."),
        303,
      );
    store.machines.trustHostKeys(m.name, m.seen_host_keys, "owner:ui");
    const why = await checkMachine(m.name);
    return c.redirect(
      why
        ? machineUrl("error", noted(`Trusted "${m.name}"'s host key, but the check failed: ${why}`))
        : machineUrl(
            "ok",
            `Trusted "${m.name}"'s host key and read the machine: see what it found below.`,
          ),
      303,
    );
  });
  app.post("/ui/settings/machines/:name/check", async (c) => {
    const name = c.req.param("name");
    if (!store.machines.get(name)?.host_keys.length)
      return c.redirect(machineUrl("error", "Trust the machine's host key first."), 303);
    const why = await checkMachine(name);
    return c.redirect(
      why
        ? machineUrl("error", noted(`"${name}": ${why}`))
        : machineUrl("ok", `Read "${name}" again.`),
      303,
    );
  });
  // An install the owner allowed: bound to the exact script the page showed, used once, now.
  app.post("/ui/settings/machines/:name/install", async (c) => {
    const f = await c.req.parseBody();
    const m = store.machines.get(c.req.param("name"));
    const id = String(f.recipe ?? "") as RecipeId;
    const fail = (why: string) => c.redirect(machineUrl("error", why), 303);
    if (!m) return fail("No such machine.");
    const facts = m.facts as MachineFacts | null;
    if (!m.host_keys.length || !facts) return fail("Trust and check the machine first.");
    if (!(id in RECIPES) || !missing(facts).includes(id))
      return fail("That isn't missing on this machine any more: press Check again.");
    if (store.machines.installs(m.name).some((i) => i.started_at && !i.finished_at))
      return fail(`An install is already running on "${m.name}".`);
    const s = recipeScript(id, facts);
    if ("error" in s) return fail(s.error);
    const sha = scriptSha(s.script);
    if (String(f.sha ?? "") !== sha)
      return fail("What control would run changed since the page showed it: read it again.");
    const approval = store.machines.approveInstall({
      machine: m.name,
      recipe: id,
      script_sha: sha,
      by: "owner:ui",
      ttlMs: 30 * 60_000,
    });
    if (!store.machines.startInstall(approval, m.name, id, sha))
      return fail("That approval can't be used.");
    const target = {
      address: m.address,
      port: m.port,
      user: m.user,
      privateKey: opts.secrets.open(m.key_sealed),
      hostKeys: m.host_keys,
    };
    // It runs on: the page shows it running, then its outcome and the machine read again.
    void ssh
      .sshScript(target, s.script, [], 30 * 60_000)
      .then(
        (r) =>
          store.machines.finishInstall(approval, r.code === 0, `${r.stdout}\n${r.stderr}`.trim()),
        (err) => store.machines.finishInstall(approval, false, errorText(err)),
      )
      .then(() => checkMachine(m.name))
      .catch(() => {});
    return c.redirect(
      machineUrl(
        "ok",
        `Installing ${RECIPES[id].title} on "${m.name}", as you allowed: this page shows when it is done.`,
      ),
      303,
    );
  });
  app.post("/ui/settings/machines/:name/decline", async (c) => {
    const id = String((await c.req.parseBody()).recipe ?? "") as RecipeId;
    const title = RECIPES[id]?.title ?? "it";
    return c.redirect(
      machineUrl(
        "ok",
        `Control won't install ${title}. Install it yourself (the commands are shown below), then press Check again.`,
      ),
      303,
    );
  });
  app.post("/ui/settings/machines/:name/delete", (c) => {
    const name = c.req.param("name");
    return c.redirect(
      store.machines.delete(name, "owner:ui")
        ? machineUrl("ok", `"${name}" is deleted: control keeps nothing of its key.`)
        : machineUrl("error", "No such machine."),
      303,
    );
  });
}
