import assert from "node:assert/strict";
import { test } from "node:test";
import { messageText, sectionsText } from "../../../src/agents/prompt.ts";
import {
  renderOwnerMessages,
  renderPlanner,
  renderWorker,
  windowFit,
} from "../../../src/agents/roles/index.ts";
import { fitToWindow } from "../../../src/agents/roles/shared.ts";
import { laneLimits } from "../../../src/core/contract.ts";

const limits = laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } });

test("the window's fit is the advisors' rule: the compaction point less 30% of the window (goal 166)", () => {
  assert.equal(windowFit(32_000), 56_000);
  assert.equal(windowFit(32_000, 85), Math.floor(32_000 * 0.55 * 3.5));
  // Never less than a fifth of the window, however early it compacts.
  assert.equal(windowFit(10_000, 40), Math.floor(10_000 * 0.2 * 3.5));
  assert.equal(windowFit(0), undefined);
  assert.equal(windowFit(undefined), undefined);
});

test("a worker's first message is cut to the window: the owner's messages and the role's text stay whole, and the cut is said", () => {
  const brief = [
    {
      id: "assignment",
      source: "assignment" as const,
      text: "# Assignment (epoch 1, trial 1 of 1, lane-1)",
    },
    {
      id: "campaign-brief",
      source: "campaign brief" as const,
      text: `# The campaign's brief\n${"b".repeat(50_000)}`,
    },
    {
      id: "notes",
      source: "field notes and past research" as const,
      text: `# Field notes\n${"n".repeat(20_000)}`,
    },
    ...renderOwnerMessages(["Keep the exported name."], ["Try the vectorised path."]),
  ];
  const at = {
    program: { id: "pi", name: "Pi", turnWords: "each model reply is one" },
    brief,
    mcpServers: [],
    limits,
    editablePaths: ["src/**"],
  };
  // No window known: nothing is cut.
  assert.doesNotMatch(messageText(renderWorker(at)), /Cut to fit/);
  const fit = 30_000;
  const text = messageText(renderWorker({ ...at, fit }));
  assert.ok(text.length <= fit + 400, `${text.length} characters`);
  assert.match(text, /# Messages from the campaign's owner, in force\n- Keep the exported name\./);
  assert.match(text, /# Messages from the campaign's owner\n- Try the vectorised path\./);
  assert.match(text, /\[Cut to fit the model's window: [\d,]+ of 50,023 characters\.\]/);
  assert.match(
    text,
    /# Cut to fit the model's window\nThis message is cut to 30,000 characters[^\n]*: campaign-brief/,
  );
  assert.match(text, /BRIEF\.md in the run's folder/);
  // In a program, the role's own instructions stay whole too.
  const opencode = messageText(
    renderWorker({
      ...at,
      program: { id: "opencode", name: "OpenCode", turnWords: "each model reply is one" },
      fit,
    }),
  );
  assert.ok(
    opencode.startsWith(
      "You are a research worker in an automated research harness, working in a git repository",
    ),
  );
  assert.match(opencode, /thermite-trial submit --hypothesis/);
});

test("a message that cannot be cut further keeps what it must, and says nothing was lost", () => {
  const owner = renderOwnerMessages(["o".repeat(5_000)], []);
  const out = fitToWindow(owner, 100, "where");
  assert.equal(sectionsText(out), sectionsText(owner));
});

test("the planner's run state is cut to the window as an advisor's package is: the owner's messages first and whole", () => {
  const context = JSON.stringify({
    evidence: "e".repeat(40_000),
    owner_messages: [{ id: 3, text: "Try the vectorised path." }],
    queue: { up_next: [] },
  });
  for (const program of ["pi", "opencode"]) {
    const text = messageText(renderPlanner({ program, context, mcpServers: [], fit: 10_000 }));
    assert.match(
      text,
      /\[Cut to fit the window: 10,000 of [\d,]+ characters\.\]\n\{"owner_messages":\[\{"id":3,"text":"Try the vectorised path\."\}\]/,
    );
    // The state alone is cut: in a program, the role's own instructions come before it, whole.
    const state = text.slice(text.indexOf("[Cut to fit the window"));
    assert.ok(state.length < 10_100, `${program}: ${state.length}`);
  }
  // Within the window: the state as it was, in its order.
  assert.match(
    messageText(renderPlanner({ program: "pi", context, mcpServers: [], fit: 100_000 })),
    /^\{"evidence"/,
  );
});
