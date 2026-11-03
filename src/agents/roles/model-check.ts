import { type Prompt, prompt, section } from "../prompt.ts";

/**
 * The model check (goal 166): one short call that shows a rig's agents can reach their model and
 * call a tool, before the agents start and when their route changes. It runs in the harness, on
 * the workers' route and program, and asks for one word back.
 */

/** In Pi, the check calls the echo tool. */
export const MODEL_CHECK_PI_SYSTEM =
  "You are checking a tool-calling route. Answer only by calling the echo tool, once.";

/** What the check asks in Pi, with the word it must get back. */
export const modelCheckPiPrompt = (word: string) => `Call echo with the word ${word}.`;

/** What the check asks an agent program, which runs one command with its shell tool. */
export const modelCheckProgramPrompt = (word: string, shellTool = "shell tool") =>
  `Use your ${shellTool} to run exactly this command: echo ${word}\nThen reply with only the word it printed.`;

/**
 * The model check's prompt (goal 166): in Pi, its instructions and the echo it asks for; in
 * another program, one message that asks its shell tool (`tool`: the tool's name, when the
 * program names it) to run echo.
 */
export function renderModelCheck(i: {
  program: string;
  word: string;
  tool?: string | undefined;
}): Prompt {
  if (i.program === "pi")
    return prompt("model-check", "pi", {
      system: [section("instructions", "role", MODEL_CHECK_PI_SYSTEM)],
      message: [section("ask", "role", modelCheckPiPrompt(i.word))],
    });
  return prompt("model-check", i.program, {
    message: [
      section(
        "ask",
        "role",
        i.tool
          ? modelCheckProgramPrompt(i.word, `${i.tool} tool`)
          : modelCheckProgramPrompt(i.word),
      ),
    ],
  });
}
