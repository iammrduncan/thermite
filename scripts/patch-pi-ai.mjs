// Patches Pi's model client after npm ci (goal 140). While a tool call streams, pi-ai parses its
// whole arguments again on each piece that arrives, with a repair that rebuilds the text
// character by character: the work grows with the square of the arguments' length, and a tool
// call of a megabyte stopped a rig's supervisor for 75 minutes. Every provider parses the whole
// arguments again when the call ends and uses that; the partial result is for a screen that shows
// a call while it streams, which Thermite has not. So past 16 KiB the partial parse is skipped.
//
// The script knows one pi-ai version and the exact text it changes. With another, the install
// stops: check the new version's parser by hand, then change PI_AI_VERSION here.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PI_AI_VERSION = "1.4.0";
const MARK = "Thermite (goal 140)";
const ORIGINAL = `export function parseStreamingJson(partialJson) {
    if (!partialJson || partialJson.trim() === "") {
        return {};
    }
`;
const PATCHED = `export function parseStreamingJson(partialJson) {
    if (!partialJson || partialJson.trim() === "") {
        return {};
    }
    // ${MARK}: past 16 KiB a streaming tool call's arguments are not parsed until the call ends.
    if (partialJson.length > 16384) {
        return {};
    }
`;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "node_modules", "@earendil-works", "pi-ai");
// npm runs postinstall for this package only; with --omit or a partial install pi-ai may be absent.
if (!existsSync(pkg)) process.exit(0);
const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
if (version !== PI_AI_VERSION) {
  console.error(
    `patch-pi-ai: pi-ai is ${version}, not ${PI_AI_VERSION}: check its parseStreamingJson (goal 140) and update scripts/patch-pi-ai.mjs`,
  );
  process.exit(1);
}
const file = join(pkg, "dist", "utils", "json-parse.js");
const text = readFileSync(file, "utf8");
if (text.includes(MARK)) process.exit(0);
if (text.split(ORIGINAL).length !== 2) {
  console.error(`patch-pi-ai: ${file} does not have the text this script changes (goal 140)`);
  process.exit(1);
}
writeFileSync(file, text.replace(ORIGINAL, PATCHED));
console.log(
  "patch-pi-ai: pi-ai's streaming tool-call parse skips arguments past 16 KiB (goal 140)",
);
