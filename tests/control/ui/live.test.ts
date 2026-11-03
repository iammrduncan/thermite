import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  advisorLabel,
  agentKind,
  type LiveEntry,
  liveEntryHtml,
  liveLinesHtml,
  resultSummary,
  runSourceName,
  toolSummary,
  whoTags,
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

  test("each program's tool calls read as what they did, and arguments a rig cut short still do (goal 188)", () => {
    const what = (text: string) => toolSummary(text).what;
    // Cut short by an older rig: the JSON never closes.
    const cut = toolSummary(
      'Bash {"command":"cd /work && nvcc -O3 pn-gemm.cu -o pn && ./pn --bench | tail -20 && echo do…',
    );
    assert.equal(cut.name, "Bash");
    assert.match(cut.what, /^<code class="lv-cmd">\$ cd \/work &amp;&amp; nvcc -O3 pn-gemm\.cu/);
    assert.match(what("shell bash -lc 'rg -n pn_gemm src'"), /\$ rg -n pn_gemm src<\/code>/);
    assert.match(
      what('Read {"file_path":"src/a.cu","offset":120,"limit":80}'),
      /<code>src\/a\.cu<\/code> <span class="muted xs">lines 120–199<\/span>/,
    );
    assert.match(
      what('Edit {"file_path":"a.cu","old_string":"int x;\\nint y;","new_string":"int x = 2;"}'),
      /edits <code>a\.cu<\/code> <span class="muted xs">−2 \+1 lines<\/span>/,
    );
    assert.match(
      what('Grep {"pattern":"__launch_bounds__","path":"src"}'),
      /<code>__launch_bounds__<\/code> in <code>src<\/code>/,
    );
    const kb = toolSummary('mcp__thermite__kb_search {"query":"wave packing"}');
    assert.deepEqual([kb.name, kb.what], ["kb_search", "“wave packing”"]);
    assert.equal(
      toolSummary('thermite.fetch_url {"url":"https://example.org/a"}').name,
      "fetch_url",
    );
    assert.equal(what('TodoWrite {"todos":[{"content":"a"},{"content":"b"}]}'), "2 to-dos");
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
      /<span class="lv-who k-lane">Worker · lane-1 <span class="muted">t-97f3630d<\/span><\/span>/,
    );
    // Text from the rig is escaped.
    assert.match(
      liveEntryHtml(e(5, "text", "<script>x</script>"), { showWho: false, name }),
      /&lt;script&gt;/,
    );
  });

  test("each advisor's lines carry its chip, its group's and every advisor's, its name and its colour (goal 188)", () => {
    const line = (source: string): LiveEntry => ({ id: 1, at, source, kind: "text", text: "x" });
    assert.equal(whoTags(line("advisor:teacher-1")), "advisors teacher-1 teachers");
    assert.equal(whoTags(line("advisor:merged-by")), "advisors merged-by teachers");
    assert.equal(whoTags(line("advisor:reviewer-2")), "advisors reviewer-2 review_panel");
    assert.equal(whoTags(line("advisor:auditor")), "advisors auditor");
    assert.equal(whoTags(line("supervisor")), "advisors");
    assert.equal(runSourceName("advisor:merged-by"), "merger");
    assert.equal(runSourceName("advisor:final-writer"), "final writer");
    assert.equal(advisorLabel("teacher-2"), "teacher-2");
    assert.deepEqual(
      [
        "trial:t-1",
        "planner",
        "judge",
        "advisor:teacher-1",
        "advisor:merged-by",
        "advisor:auditor",
        "advisor:reviewer-1",
        "advisor:synthesizer",
        "supervisor",
      ].map(agentKind),
      ["lane", "planner", "judge", "teacher", "merger", "auditor", "reviewer", "writer", "advisor"],
    );
    const html = liveEntryHtml(line("advisor:teacher-1"), { showWho: true, name: runSourceName });
    assert.match(html, /<span class="lv-who k-teacher">teacher-1<\/span>/);
    assert.doesNotMatch(html, /unsigned/, "the supervisor's advisors are not marked unsigned");
  });
});
