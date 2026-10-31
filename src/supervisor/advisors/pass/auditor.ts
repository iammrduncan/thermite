import { errorText } from "../../../common/errors.ts";
import { AUDITS, AUDITS_PENDING } from "../../../core/api/harness/advisors.ts";
import { auditOne } from "../auditor.ts";
import type { AdviseContext } from "./context.ts";
import { clip } from "./shared.ts";
import { MAX_TRIES } from "./state.ts";

/** The auditor's part of a pass: each open audit, tried again until its tries are spent. */
export async function answerAudits(ctx: AdviseContext): Promise<void> {
  const {
    cfg,
    harness,
    next,
    s,
    now,
    retryMs,
    due,
    mark,
    toolsFor,
    kbFor,
    configFor,
    additionsFor,
    keeperFor,
    mcpFor,
    overBudget,
    count,
    record,
    say,
    fail,
    usageOut,
    promptsOut,
    receipts,
    toQueue,
    notesOut,
  } = ctx;
  // The auditor: open audits. An audit can block, never pass; the harness enforces that too.
  if (cfg.advisors.auditor && !overBudget()) {
    const auditor = cfg.advisors.auditor;
    // Each audit has its own id: each confirmation of an attempt has an audit of its own.
    const { audits } = await harness.call(AUDITS_PENDING);
    // The owner's messages go to the auditor once, with the first audit that gets them.
    const told = new Set<number>();
    // Each audit's tries are its own, by its id (goal 079): a new audit of the same attempt starts
    // afresh. The markers of audits no longer open go.
    const keyOf = (pkg: { id?: number; attempt: string }) => `audit:${pkg.id ?? pkg.attempt}`;
    const open = new Set(audits.map(keyOf));
    next.auditErrors ??= {};
    const errors = next.auditErrors;
    for (const k of [...Object.keys(next.tried), ...Object.keys(errors)]) {
      if (!k.startsWith("audit:") || open.has(k)) continue;
      delete next.tried[k];
      delete next.tries[k];
      delete errors[k];
    }
    /**
     * An audit whose tries are spent goes to the owner (goal 079), with the last error: hands-off
     * leaves no other step. A hand-off that does not reach the harness is tried again every
     * retryMs, while the audit is still open: an audit never waits with nobody told.
     */
    const toOwner = async (pkg: { attempt: string; run?: string }, key: string) => {
      next.tried[key] = new Date().toISOString();
      try {
        const why = errors[key] ?? "no detail";
        await harness.call(AUDITS, {
          body: {
            attempt: pkg.attempt,
            decision: "needs_owner",
            reasons: `the auditor could not answer after ${MAX_TRIES} tries: ${why}`,
            citations: [],
            auditor: auditor.name,
          },
        });
        say(
          pkg.run,
          "status",
          `audit of ${pkg.attempt}: the auditor could not answer after ${MAX_TRIES} tries, so it waits for the owner`,
        );
      } catch (e) {
        fail(
          `audit of ${pkg.attempt}: handing it to the owner (tried again in ${Math.round(retryMs / 60_000)} minutes)`,
          e,
          pkg.run,
        );
      }
    };
    /** An audit the auditor could not answer: tried again later, or, its last try, the owner's. */
    const failed = async (
      pkg: { attempt: string; run?: string },
      key: string,
      err: unknown,
    ): Promise<void> => {
      fail(`audit of ${pkg.attempt}`, err, pkg.run);
      errors[key] = clip(errorText(err), 500);
      if ((next.tries[key] ?? 0) < MAX_TRIES) return;
      await toOwner(pkg, key);
    };
    for (const pkg of audits) {
      const key = keyOf(pkg);
      // Its tries are spent and it is still open: its hand-off to the owner did not reach the
      // harness. It is handed again.
      if ((next.tries[key] ?? 0) >= MAX_TRIES) {
        const t = next.tried[key];
        if (!t || now - Date.parse(t) >= retryMs) await toOwner(pkg, key);
        continue;
      }
      if (!due(key)) continue;
      mark(key);
      const owner = (pkg.owner_messages ?? []).filter((m) => !told.has(m.id));
      try {
        const r = await auditOne({
          // With the campaign's own context settings, when it sets any (goal 070).
          config: await configFor(pkg.run),
          pkg: { ...pkg, owner_messages: owner },
          keeper: keeperFor(pkg.run),
          additions: await additionsFor(pkg.run),
          tools: {
            ...toolsFor(),
            mcp: await mcpFor(pkg.run),
            // Thermite's knowledge base, from the run's scope (goal 175).
            ...(pkg.run ? { kb: await kbFor(pkg.run, "auditor") } : {}),
          },
        });
        count(r);
        await usageOut(pkg.run, `audit ${pkg.attempt}`, "auditor", r.usage);
        await promptsOut(pkg.run, `audit ${pkg.attempt}`, r.sent);
        if (!r.output) {
          await failed(pkg, key, r.error);
          continue;
        }
        const posted = await harness.call(AUDITS, {
          body: {
            attempt: pkg.attempt,
            decision: r.output.decision,
            reasons: r.output.reasons,
            citations: r.output.citations,
            auditor: auditor.name,
          },
        });
        s.audits++;
        // Read only with the posted audit: an audit that fails to post gives them again.
        if (pkg.run) {
          await receipts(
            pkg.run,
            "auditor",
            owner.map((m) => m.id),
            r.output.answers.map((a) => ({ ...a, advisor: auditor.name })),
          );
          for (const m of owner) told.add(m.id);
        }
        say(
          pkg.run,
          "text",
          `audit of ${pkg.attempt} (try ${next.tries[key] ?? 1}): ${r.output.decision}${posted?.effect ? `, ${posted.effect}` : ""}. ${clip(r.output.reasons, 400)}`,
        );
        // A doubt the auditor could not settle: a check at the top of the run's queue.
        const check = r.output.check;
        const queued =
          check && pkg.run
            ? await toQueue(
                pkg.run,
                "auditor",
                [{ ...check, family: "check", position: "top" }],
                [],
              )
            : undefined;
        // Its field notes, once the audit is posted.
        const noted = pkg.run
          ? await notesOut(pkg.run, "auditor", auditor.name, r.output.journal)
          : undefined;
        record(`audit-${pkg.attempt}`, {
          decision: r.output,
          posted,
          queued,
          noted,
          ...(r.compactions?.length ? { compactions: r.compactions } : {}),
        });
      } catch (err) {
        await failed(pkg, key, err);
      }
    }
  }
}
