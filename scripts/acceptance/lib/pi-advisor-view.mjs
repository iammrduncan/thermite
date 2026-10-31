// The acceptance scene "an advisor in Pi in its Pi view" (goal 169), for the steering check: on a
// rig whose agents run in their own terminal (the default), a teacher in Pi works in its Pi view,
// in a process of its own that the supervisor image's terminal host runs as an advisor user. The
// scripted model holds the first reply of one teacher's call while the scene types one input into
// its view from the owner's console (`terminal_input`, checked and recorded by the harness, handed
// to the supervisor) and sends the teachers one owner's message (`message_agent`); the teacher's
// next model call must hold both, the owner's message as the Pi advisor's later turn, and its
// answer must end the call. Live must draw the call as a Pi view while it runs.

import { api, command, sleep, until } from "./smoke-env.mjs";
import { screenOnLive } from "./terminals.mjs";

/** The words the scene sends, which the model looks for. */
const TYPED = "PI-VIEW-TYPED Look at the timer code.";
const MESSAGE = "PI-VIEW-MESSAGE Check the timer before you advise.";
/** The Pi advisor's words around an owner's message (src/agents/roles/shared.ts). */
const OWNER_PI = "answer it in answers with the others when you call answer";
/** The teacher whose call the scene holds: its model's name in the advisors file. */
const TEACHER = "teacher-a";

/**
 * The scene's part of the scripted model, and the scene itself. `turn(model, messages, answer)`:
 * the teacher's turn while the scene is on, or undefined, when the script answers as it does.
 */
export function piAdvisorScene() {
  const s = { active: false, heldAt: 0, release: undefined, released: false, done: undefined };
  return {
    turn(model, messages, answer) {
      if (!s.active || model !== TEACHER || s.done) return undefined;
      const said = JSON.stringify(messages);
      if (said.includes(TYPED) && said.includes(MESSAGE)) {
        s.done = { said, at: Date.now() };
        return answer;
      }
      // Its first reply waits until the scene has typed into it and sent the message, then calls a
      // tool, so its next model call takes both.
      if (!s.heldAt) s.heldAt = Date.now();
      return (async () => {
        const until = Date.now() + 180_000;
        while (!s.released && Date.now() < until) await sleep(250);
        return { toolCalls: [{ name: "brief", args: {} }] };
      })();
    },
    /** Runs the scene on rig 1's run smoke-1; `check` records each result, `rigEvents` reads its events. */
    async run(check, rigEvents) {
      s.active = true;
      try {
        await until("a teacher's call held in its Pi view", async () => s.heldAt, 300_000, 500);
        const call = await until(
          "the teacher's call listed among the rig's terminals",
          async () =>
            ((await api("/v1/rigs/local-1/view")).body.summary?.work?.terminals ?? []).find(
              (x) => x.role === TEACHER && x.run === "smoke-1",
            ),
          120_000,
          1000,
        );
        const frame = await screenOnLive(call.id);
        check(
          "Live draws the teacher's call in Pi as its Pi view, while it runs in the supervisor",
          /^advisor-teacher-a-smoke-1-\d+$/.test(call.id) &&
            frame?.state === "running" &&
            frame?.pi_view === true,
          { call, frame: frame && { ...frame, data: undefined } },
        );
        const typed = await command("terminal_input", {
          run: "smoke-1",
          trial: call.id,
          text: TYPED,
        });
        await command("message_agent", { run: "smoke-1", to: "teachers", text: MESSAGE });
        // The supervisor reads the owner's messages for its calls every 5 seconds.
        await sleep(8000);
        s.released = true;
        await until("the teacher's answer after both", async () => s.done, 180_000, 500);
        check(
          "the input typed into the teacher's Pi view was typed, and steered its next model call",
          typed.outcome?.result?.outcome === "typed" && s.done.said.includes(TYPED),
          typed.outcome,
        );
        check(
          "the owner's message went into the teacher's call before its next model call, in the Pi advisor's words",
          s.done.said.includes(MESSAGE) && s.done.said.includes(OWNER_PI),
          { held_for_ms: s.done.at - s.heldAt },
        );
        const events = await rigEvents("local-1");
        check(
          "the input is recorded word for word, as a trial's is",
          events.some(
            (e) =>
              e.kind === "terminal_input" &&
              e.body.trial === call.id &&
              e.body.text === TYPED &&
              e.body.outcome === "typed",
          ),
          events.filter((e) => e.kind === "terminal_input").slice(-3),
        );
        await until(
          "the teacher's call ended",
          async () =>
            !((await api("/v1/rigs/local-1/view")).body.summary?.work?.terminals ?? []).some(
              (x) => x.id === call.id,
            ),
          120_000,
          1000,
        );
        check("the teacher's call ended once it answered, and left the rig's terminals", true);
      } finally {
        s.active = false;
        s.released = true;
      }
    },
  };
}
