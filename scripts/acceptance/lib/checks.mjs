/**
 * The acceptance scripts' checks (goal 125, T3): one way to say PASS or FAIL, what was checked and
 * its detail, and to keep each result for the script's report.
 *
 * - `max` cuts a long detail where it is printed; the report keeps it whole.
 * - `into` is the list the results go to, such as the report's `checks`.
 * - `stop` ends the script at the first failure, by throwing.
 */
export function acceptanceChecks({ max = Number.POSITIVE_INFINITY, into = [], stop = false } = {}) {
  const results = into;
  /** One check: true when it passed. */
  const check = (name, ok, detail) => {
    const passed = Boolean(ok);
    results.push({ name, ok: passed, ...(detail === undefined ? {} : { detail }) });
    const words =
      detail === undefined || detail === ""
        ? ""
        : typeof detail === "string"
          ? detail
          : JSON.stringify(detail);
    console.log(`${passed ? "PASS" : "FAIL"} ${name}${words ? `: ${words.slice(0, max)}` : ""}`);
    if (!passed && stop) throw new Error(`failed: ${name}`);
    return passed;
  };
  return { check, results, failed: () => results.filter((r) => !r.ok).length };
}
