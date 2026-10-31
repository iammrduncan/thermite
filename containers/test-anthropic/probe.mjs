// Test only (scripts/acceptance/claude-real.mjs): an agent's command in a trial in Claude Code. It
// prints its user and whether the sign-in token, given in parts as its arguments, is in any
// environment it can read: its own, and those of the processes above it up to the broker's
// (Claude Code's among them). It never prints the token.
import { readFileSync } from "node:fs";

const token = process.argv.slice(2).join("");
const found = [];
if (Object.values(process.env).some((v) => v.includes(token))) found.push("its own");
let pid = process.ppid;
for (let i = 0; i < 8 && pid > 1; i++) {
  try {
    if (readFileSync(`/proc/${pid}/environ`, "latin1").includes(token)) found.push(`pid ${pid}`);
  } catch {
    // another user's process: closed to this one
  }
  try {
    pid = Number(readFileSync(`/proc/${pid}/stat`, "latin1").split(") ")[1]?.split(" ")[1]);
  } catch {
    break;
  }
}
console.log(`uid=${process.getuid()} signin=${found.length ? `FOUND in ${found.join(", ")}` : "absent"}`);
