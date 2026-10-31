import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repo } from "./context.mjs";

// ---------------------------------------------------------------- the scripted model

const GOOD = readFileSync(join(repo, "kits/smoke-cpu/candidates/good/src/kernel/matmul.c"));
export const HYPOTHESIS = "i-k-j loop order makes the inner loop contiguous";
/**
 * The agents acceptance's script, cut to the quick start: OpenCode's model check, the planner's
 * one-lane plan, and one OpenCode trial that writes the smoke kit's known-good kernel and submits
 * it with thermite-trial.
 */
export function script(messages, tools) {
  const names = tools.map((t) => t.function.name);
  const asked = JSON.stringify(messages);
  const results = messages.filter((m) => m.role === "tool").length;
  if (names.includes("shell") && names.includes("execute")) {
    const word = /run exactly this command: echo (thermite-[a-z0-9]+)/.exec(asked)?.[1];
    if (results) return { text: "done" };
    if (word) return { toolCalls: [{ name: "shell", args: { command: `echo ${word}` } }] };
    return {
      toolCalls: [
        {
          name: "shell",
          args: {
            command: `printf '%s' '${GOOD.toString("base64")}' | base64 -d > src/kernel/matmul.c && thermite-trial submit --hypothesis '${HYPOTHESIS}'`,
            timeout: 0,
          },
        },
      ],
    };
  }
  // A request without tools names OpenCode's session.
  if (!tools.length) return { text: "A Thermite trial" };
  if (names.includes("echo")) {
    if (results) return { text: "done" };
    return {
      toolCalls: [{ name: "echo", args: { word: /the word (\S+)\./.exec(asked)?.[1] ?? "" } }],
    };
  }
  if (names.includes("submit_plan"))
    return {
      toolCalls: [
        {
          name: "submit_plan",
          args: {
            new_families: [{ id: "loop-order", description: "change the loop order for locality" }],
            assignments: [
              {
                lane: "lane-1",
                family: "loop-order",
                focus: "make the inner loop contiguous",
                parent: "champion",
              },
            ],
          },
        },
      ],
    };
  return { text: "done" };
}
