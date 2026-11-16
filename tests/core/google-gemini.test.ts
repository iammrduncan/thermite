import assert from "node:assert/strict";
import { test } from "node:test";
import { reaches } from "../../src/core/agents.ts";
import { GoogleGenerateBody } from "../../src/core/google-gemini.ts";

const body = { contents: [{ role: "user", parts: [{ text: "fixture" }] }] };
test("native tool round-trip keeps opaque signatures and function results", () => {
  const b = {
    contents: [
      body.contents[0],
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "answer", args: { n: 7 }, id: "0-call" },
            thoughtSignature: "b3BhcXVlLWZpeHR1cmU=",
          },
        ],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "answer", response: { output: "7" }, id: "0-call" } }],
      },
    ],
    tools: [
      {
        functionDeclarations: [
          {
            name: "answer",
            parametersJsonSchema: { type: "object", properties: { n: { type: "integer" } } },
          },
        ],
      },
    ],
  };
  assert.deepEqual(GoogleGenerateBody.parse(b), b);
});
for (const [label, mutation] of [
  ["provider URL override", { httpOptions: { baseUrl: "https://example.invalid" } }],
  ["another service tier", { serviceTier: "priority" }],
  ["cached content", { cachedContent: "cachedContents/fixture" }],
  ["built-in code execution", { tools: [{ codeExecution: {} }] }],
  ["built-in search", { tools: [{ googleSearch: {} }] }],
  [
    "remote file fetch",
    { contents: [{ parts: [{ fileData: { fileUri: "https://example.invalid/private" } }] }] },
  ],
  ["nonfinite generation", { generationConfig: { temperature: Number.NaN } }],
] as const)
  test(`content boundary refuses ${label}`, () => {
    assert.equal(GoogleGenerateBody.safeParse({ ...body, ...mutation }).success, false);
  });
test("a Gemini API key uses Pi's native adapter and refuses the programs without one", () => {
  assert.equal(reaches("pi", "google-gemini-api"), true);
  for (const harness of ["opencode", "codex", "claude-code"] as const)
    assert.equal(reaches(harness, "google-gemini-api"), false);
});
