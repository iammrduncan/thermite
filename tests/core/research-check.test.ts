import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  labelledQuestion,
  measurementIn,
  questionLabel,
  questionName,
} from "../../src/core/research-check.ts";

describe("what asks for a measurement (goal 117)", () => {
  test("acts of measuring are caught, with the words that ask", () => {
    const cases: [string, string][] = [
      ["Benchmark the WMMA kernel against the cuBLAS call", "Benchmark the"],
      ["Run a microbenchmark of shared-memory bank conflicts", "Run a microbenchmark"],
      ["Write a small benchmark for the dequantize step", "Write a small benchmark"],
      ["Profile the kernel with Nsight Compute", "Profile the"],
      ["Run the profiler on each variant", "Run the profiler"],
      ["Time each variant and keep the fastest", "Time each"],
      ["Collect the layouts, then time them", "then time them"],
      ["Measure the latency of a warp shuffle", "Measure the"],
      ["We need to measure how often the cache misses", "to measure how"],
      ["A/B test the two layouts", "A/B"],
      ["Compare them with an AB test", "AB test"],
      ["Run the litmus tests on the hardware", "Run the litmus tests on the hardware"],
      ["Check the fence behaviour: run it on the card", "run it on the card"],
      ["Verify the bound on the real box", "Verify the bound on the real box"],
      [
        "Test whether preemption happens on our target machine",
        "Test whether preemption happens on our target machine",
      ],
      ["Confirm the result on-box", "on-box"],
      ["Run a litmus test for the message-passing pattern", "Run a litmus"],
      ["Matched control: the same kernel without the fence", "Matched control"],
      ["Expected gain: 5% fewer stalls", "Expected gain"],
      ["Use a dev-run to check the occupancy", "dev-run"],
    ];
    for (const [text, words] of cases) assert.equal(measurementIn(text), words, text);
  });

  test("tasks about what sources report are not measurements", () => {
    for (const text of [
      "Find the published benchmark results for the A100",
      "Collect papers that profile memory traffic on Volta",
      "Read the Nsight Compute documentation of the sm__throughput metric",
      "Find sources on the hardware scheduler of Volta",
      "At the time the paper was written, which GPUs had tensor cores?",
      "Dissecting the Volta architecture via microbenchmarking: read its tables",
      "Look for papers on machine learning compilers",
      "Litmus test results reported in the literature for PTX",
      "Find the measured latencies that vendors publish",
      "What does the CUDA guide say about timing with events?",
      "Search for a/b notation in the PTX manual",
      "Check NVIDIA's documentation on the GPU memory model",
      "Primary sources for Question 2 (index 1): the scheduling policy",
    ])
      assert.equal(measurementIn(text), undefined, text);
  });
});

describe("question numbers (goal 117)", () => {
  test("people read from 1; agents get the index too; a label gives its index back", () => {
    assert.equal(questionName(0), "Question 1");
    assert.equal(questionLabel(0), "Question 1 (index 0)");
    assert.equal(labelledQuestion("Question 3 (index 2): explore"), 2);
    assert.equal(labelledQuestion("question 3 ( index 2 )"), 2);
    assert.equal(labelledQuestion("Question 2: explore"), undefined);
  });
});
