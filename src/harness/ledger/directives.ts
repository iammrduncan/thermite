import { canonicalJson } from "../../core/canonical.ts";
import { convertedRule, isLegacyRule } from "../../core/directions.ts";
import { LedgerError, LedgerPart, type Row } from "./part.ts";

/** A rule's kind and what it names, to tell the same rule set again. */
function ruleKey(body: unknown): string {
  const b = (body ?? {}) as { kind?: unknown; family?: unknown; match?: unknown };
  return `${String(b.kind ?? "")}|${String(b.family ?? b.match ?? "")
    .trim()
    .toLowerCase()}`;
}

/** The `directive` table: the runs' rules and directions. */
export class LedgerDirectives extends LedgerPart {
  add(run: string, author: string, body: unknown): number {
    return this.tx(() => {
      const id = this.execute(
        "insert into directive (run, author, body, created_at) values (?, ?, ?, ?)",
        run,
        author,
        canonicalJson(body),
        this.now(),
      ).id;
      this.ledger.appendEvent(author, "directive", run, { id, body });
      return id;
    });
  }

  /**
   * A directive set. With `replace`, the author's active directives for the run are
   * superseded first: each author steers with one current set, not an ever-growing pile.
   */
  addSet(run: string, author: string, bodies: unknown[], replace: boolean): number[] {
    return this.tx(() => {
      let keep = bodies;
      // A rule the owner removed never comes back with an advisor's, the planner's or an agent's
      // next set; only the owner (or an operator for the owner) can set it again.
      if (author !== "control:owner" && !author.startsWith("control:owner:")) {
        const gone = new Set(
          this.rows<Row>(
            "select body from directive where run = ? and status = 'dropped'",
            run,
          ).map((r) => ruleKey(JSON.parse(String(r.body)))),
        );
        const left = bodies.filter((b) => gone.has(ruleKey(b)));
        if (left.length) {
          keep = bodies.filter((b) => !gone.has(ruleKey(b)));
          this.ledger.appendEvent(author, "directives_left_out", run, {
            rules: left,
            why: "the owner removed these rules",
          });
        }
      }
      if (replace) {
        const old = this.rows<Row>(
          "select id from directive where run = ? and author = ? and status = 'active'",
          run,
          author,
        ).map((r) => Number(r.id));
        if (old.length) {
          this.execute(
            "update directive set status = 'superseded', superseded_at = ? where run = ? and author = ? and status = 'active'",
            this.now(),
            run,
            author,
          );
          this.ledger.appendEvent(author, "directives_superseded", run, { ids: old });
        }
      }
      return keep.map((b) => this.add(run, author, b));
    });
  }

  /**
   * The owner removes a rule for the plan in force (drop_directive), whoever set it. The rule
   * stays in the record as dropped, with its event.
   */
  drop(run: string, id: number, actor: string): void {
    this.tx(() => {
      const r = this.execute(
        "update directive set status = 'dropped', superseded_at = ? where id = ? and run = ? and status = 'active'",
        this.now(),
        id,
        run,
      );
      if (r.changes === 0)
        throw new LedgerError("not_found", `no rule ${id} in force in run ${run}`);
      this.ledger.appendEvent(actor, "directive_dropped", run, { id });
    });
  }

  /**
   * The planner's round converts an old rule in words to a rule on a named direction (goal 066):
   * a new rule with the old one's author, kind, why, citations and source, that names the rule and
   * the words it was converted from (its `directive` event is its author's, as the old one's was).
   * The old rule ends as converted (`directive_converted`, by `actor`): never dropped silently.
   * One transaction. Returns the new rule's id.
   */
  convertRule(run: string, id: number, family: string, actor: string): number {
    return this.tx(() => {
      const old = this.row<Row>(
        "select author, body from directive where id = ? and run = ? and status = 'active'",
        id,
        run,
      );
      if (!old) throw new LedgerError("not_found", `no rule ${id} in force in run ${run}`);
      const body = JSON.parse(String(old.body)) as Record<string, unknown>;
      if (!isLegacyRule(body))
        throw new LedgerError("invalid", `rule ${id} names a direction already`);
      const to = this.add(run, String(old.author), convertedRule(id, body, family));
      this.execute(
        "update directive set status = 'converted', superseded_at = ? where id = ?",
        this.now(),
        id,
      );
      this.ledger.appendEvent(actor, "directive_converted", run, {
        id,
        to,
        kind: body.kind,
        family,
        words: body.match,
      });
      return to;
    });
  }

  active(run: string): { id: number; author: string; body: unknown }[] {
    return this.rows<Row>(
      "select id, author, body from directive where run = ? and status = 'active' order by id",
      run,
    ).map((r) => ({
      id: Number(r.id),
      author: String(r.author),
      body: JSON.parse(String(r.body)),
    }));
  }
}
