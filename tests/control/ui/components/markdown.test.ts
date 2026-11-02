import assert from "node:assert/strict";
import { test } from "node:test";
import { mdHtml } from "../../../../src/control/ui/components/markdown.ts";

const PAPER = `# How to Study Open Model Weights

## Abstract

This paper covers **five** questions [1, 2].

- see https://example.com/paper
- [the hub](https://example.com/hub)

<script>alert(1)</script>`;

test("Markdown reads formatted, with no HTML let through", () => {
  const html = mdHtml(PAPER);
  assert.match(html, /<h3>How to Study Open Model Weights<\/h3>/);
  assert.match(html, /<h4>Abstract<\/h4>/);
  assert.match(html, /<p>This paper covers <b>five<\/b> questions \[1, 2\]\.<\/p>/);
  assert.match(html, /<li>see <a href="https:\/\/example\.com\/paper"/);
  assert.match(
    html,
    /<a href="https:\/\/example\.com\/hub" rel="noopener noreferrer" target="_blank">the hub<\/a>/,
  );
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("with links off, as for an agent's words, an address stays the text it was written as", () => {
  const html = mdHtml(PAPER, { links: false });
  assert.match(html, /<h3>How to Study Open Model Weights<\/h3>/);
  assert.ok(!html.includes("<a "), html);
  assert.match(html, /<li>see https:\/\/example\.com\/paper<\/li>/);
  assert.match(html, /<li>\[the hub\]\(https:\/\/example\.com\/hub\)<\/li>/);
});
