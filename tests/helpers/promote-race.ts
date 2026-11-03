// Child process for the promotion race test: waits for a start time, then tries a CAS promotion.
import { Ledger } from "../../src/harness/ledger/index.ts";

const [dbPath, attempt, startAt] = process.argv.slice(2) as [string, string, string];
const ledger = Ledger.open(dbPath);
while (Date.now() < Number(startAt)) {
  // spin until both racers are ready
}
const r = ledger.champions.promote({
  run: "race-1",
  expectedSeq: 1,
  attempt,
  commitSha: String(ledger.attempts.get(attempt)?.commit_sha),
  by: attempt,
});
process.stdout.write(JSON.stringify(r));
ledger.close();
