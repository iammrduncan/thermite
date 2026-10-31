import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type LiveEntry,
  liveEntryHtml,
  liveLinesHtml,
  resultSummary,
  toolSummary,
} from "../../../src/control/ui/live.ts";

const name = (s: string, lane?: string | null) => (s.startsWith("trial:") ? `Worker · ${lane}` : s);
const at = "2026-10-18T01:44:51.000Z";
const e = (id: number, kind: string, text: string): LiveEntry => ({
  id,
  at,
  source: "trial:t-97f3630df8cb46fe",
  lane: "lane-1",
  kind,
  text,
  signed: true,
});

describe("the live view's lines", () => {
  test("a tool call reads as the command or file it touched, not as JSON", () => {
    const run = toolSummary(
      'run {"command":"df -h /scratch | head; ls -la /scratch/cache\\nwc -l x"}',
    );
    assert.equal(run.name, "run");
    assert.match(
      run.what,
      /<code class="lv-cmd">\$ df -h \/scratch \| head; ls -la \/scratch\/cache<\/code>/,
    );
    assert.match(run.what, /\+1 lines/);
    assert.equal(run.detail, "df -h /scratch | head; ls -la /scratch/cache\nwc -l x");
    const write = toolSummary(
      'write_file {"path":"checks/pn_header.py","content":"import struct\\nP = 1\\n"}',
    );
    assert.match(
      write.what,
      /writes <code>checks\/pn_header\.py<\/code> <span class="muted xs">3 lines<\/span>/,
    );
    assert.equal(write.detail, "import struct\nP = 1\n");
    const other = toolSummary('submit {"hypothesis":"two fixes","files":2}');
    assert.match(other.what, /hypothesis=two fixes · files=2/);
    assert.equal(toolSummary("<b>odd</b> text").what, "text");
  });

  test("a result shows its time, exit code and first line of output; a failure is marked", () => {
    const ok = resultSummary("run (171 ms): exit 0\nok");
    assert.match(ok.hint, /^<span class="lv-res muted">171 ms · exit 0 · ok<\/span>$/);
    const dev = resultSummary(
      'dev_run (18652 ms): {"ran":true,"exit":1,"killed":null,"wall_ms":18652,"stdout":"","stderr":"Traceback: no module named gguf\\n"}',
    );
    assert.match(dev.hint, /lv-res bad">18\.7 s · exit 1 · Traceback: no module named gguf/);
    assert.equal(dev.detail.trim(), "Traceback: no module named gguf");
    assert.match(resultSummary("run failed (5 ms): spawn error").hint, /bad">5 ms · failed/);
  });

  test("every line has its time; a result joins the call before it", () => {
    const html = liveLinesHtml(
      [
        e(1, "thinking", "I should check the header first.\nThen the loader."),
        e(2, "tool", 'run {"command":"cat gguf_read.py"}'),
        e(3, "result", "run (170 ms): exit 0\nimport gguf"),
        e(4, "text", "The header is fine."),
      ],
      { showWho: true, name },
    );
    assert.equal(
      html.match(/<span class="lv-t" title="2026-10-18 01:44:51 UTC · [^"]+">01:44:51<\/span>/g)
        ?.length,
      3,
    );
    assert.match(html, /Thinking <span class="muted">· I should check the header first\.<\/span>/);
    assert.match(
      html,
      /<span class="lv-hint"><span class="lv-res muted">170 ms · exit 0 · import gguf<\/span><\/span>/,
    );
    assert.doesNotMatch(html, /lv-name">result/);
    assert.match(
      html,
      /<span class="lv-who">Worker · lane-1 <span class="muted">t-97f3630d<\/span><\/span>/,
    );
    // Text from the rig is escaped.
    assert.match(
      liveEntryHtml(e(5, "text", "<script>x</script>"), { showWho: false, name }),
      /&lt;script&gt;/,
    );
  });
});
