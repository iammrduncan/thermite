import assert from "node:assert/strict";
import { test } from "node:test";
import { startDrawer } from "../../../../src/control/ui/campaigns/list.ts";

/** Start a run: the run to copy experiments from, and each rig as free, busy or other hardware. */

test("Start a run chooses the run to copy from that the link names (goal 099)", () => {
  const html = (copyPick?: string) =>
    startDrawer({
      campaign: "quality",
      csrf: "c",
      open: true,
      rigs: [{ id: "rig-a", hardware: "6 CPU", stale: false, model: "m-1" }],
      models: [],
      from: "Control assigns the campaign again.",
      copyFrom: [
        { key: "q-2", label: "q-2 (3 up next)" },
        { key: "q-1", label: "q-1 (1 up next)" },
      ],
      copyPick,
    });
  assert.match(html("q-1"), /<option value="q-1" selected>q-1 \(1 up next\)<\/option>/);
  assert.doesNotMatch(html("q-1"), /value="q-2" selected/);
  assert.doesNotMatch(html(), / selected>/);
});

test("Start a run lists each rig as free, busy or other hardware; a rig of other hardware can't be chosen", () => {
  const html = startDrawer({
    campaign: "speed",
    csrf: "c",
    open: true,
    rigs: [
      { id: "gpu-a", hardware: "1× P100", busy: "speed-3", stale: false, model: "m-1" },
      { id: "gpu-b", hardware: "2× P100", stale: false },
      {
        id: "cpu-a",
        hardware: "6 CPU",
        off: "Other hardware: this campaign is measured on cuda, this rig on cpu.",
        stale: false,
      },
    ],
    models: [],
    from: "Control assigns the campaign again.",
  });
  const rigs = [
    ...html.matchAll(
      /<label class="sopt( dis)?"><input type="radio" name="rig" value="([^"]+)"[^>]*?( checked)?( disabled)?>[\s\S]*?<span class="sd">([\s\S]*?)<\/span><\/span><span class="sr">([\s\S]*?)<\/span><\/label>/g,
    ),
  ].map((m) => ({
    rig: m[2],
    checked: Boolean(m[3]),
    disabled: Boolean(m[1] && m[4]),
    says: (m[5] ?? "").replace(/<[^>]+>/g, ""),
    tag: (m[6] ?? "").replace(/<[^>]+>/g, ""),
  }));
  assert.deepEqual(rigs, [
    {
      rig: "gpu-a",
      checked: false,
      disabled: false,
      says: "Busy: speed-3 is at work there, and pauses when this run starts (a rig runs one run at a time). Agents' model: m-1.",
      tag: "busy",
    },
    {
      rig: "gpu-b",
      checked: true,
      disabled: false,
      says: "Free: no run at work. No model for its agents yet.",
      tag: "free",
    },
    {
      rig: "cpu-a",
      checked: false,
      disabled: true,
      says: "Other hardware: this campaign is measured on cuda, this rig on cpu.",
      tag: "",
    },
  ]);
});
