import {
  Bubble,
  BubbleContent,
  Markdown,
  Message,
  MessageContent,
  type ToolLabelSpec,
  type TraceStep,
  TraceSteps,
} from "@iammrduncan/magnesium/chat";
import { FileCode2Icon, TerminalIcon } from "lucide-react";

const TOOL_LABELS: Record<string, ToolLabelSpec> = {
  read_file: {
    icon: FileCode2Icon,
    doing: "Reading file",
    done: "Read file",
    failed: "Could not read file",
    gist: (i) => i?.path,
  },
  run_bench: {
    icon: TerminalIcon,
    doing: "Running benchmark",
    done: "Ran benchmark",
    failed: "Benchmark failed",
    gist: (i) => i?.target,
  },
};

const STEPS: TraceStep[] = [
  {
    type: "reasoning",
    text: "Unrolling the inner half2 reduction by 4 removes loop overhead without increasing register spills.",
  },
  {
    type: "tool",
    id: "t1",
    name: "read_file",
    input: { path: "kernels/gemv_f16.cu" },
    output: "Read 148 lines from kernels/gemv_f16.cu",
    done: true,
  },
  {
    type: "tool",
    id: "t2",
    name: "run_bench",
    input: { target: "matmul-cpu" },
    output: "median: 14.2 ms (baseline 16.1 ms, +13.4% speedup)",
    done: true,
  },
];

const REPLY = `Candidate **#18** passed correctness and improved throughput by **+13.4%**.

- Guard metric (\`max_abs_err\`): \`2.1e-6\` (within \`1e-5\`)
- Next hypothesis: align shared-memory stride to avoid bank conflicts`;

export default function ChatAndTraceShowcase() {
  return (
    <div className="grid gap-4 rounded-xl border bg-card p-4">
      <Message align="end">
        <MessageContent>
          <Bubble>
            <BubbleContent>
              Focus the next batch on memory bandwidth without increasing error.
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
      <Message align="start">
        <MessageContent className="grid gap-3">
          <TraceSteps steps={STEPS} toolLabels={TOOL_LABELS} />
          <Markdown mode="static">{REPLY}</Markdown>
        </MessageContent>
      </Message>
    </div>
  );
}
