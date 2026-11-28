import { CircleAlertIcon, CircleCheckIcon, LoaderCircleIcon, WrenchIcon } from "lucide-react";
import { type ComponentType, type ReactNode, useState } from "react";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "../primitives/trace.tsx";

export interface TraceReasoningStep {
  type: "reasoning";
  text: string;
}

export interface TraceToolStep {
  type: "tool";
  id: string;
  name: string;
  input?: unknown;
  inputPreview?: string;
  output?: string;
  error?: boolean;
  done: boolean;
}

export type TraceStep = TraceReasoningStep | TraceToolStep;

export interface ToolLabelSpec {
  icon?: ComponentType<{ className?: string }>;
  doing: string;
  done: string;
  failed: string;
  gist?: (input: Record<string, unknown> | undefined) => unknown;
}

const DEFAULT_MAX_CHARS = 4000;

const isFailedCall = (call: TraceToolStep) =>
  call.error === true || (call.done && call.output === undefined);

const firstText = (input: Record<string, unknown> | undefined) =>
  Object.values(input ?? {}).find((v): v is string => typeof v === "string" && v.trim() !== "");

/**
 * API-agnostic collapsible agent trace rendering reasoning thoughts and tool invocations on top
 * of the stock `Trace` primitive. Two or more steps fold under one summary row (open while active).
 */
export function TraceSteps({
  steps,
  working = false,
  toolLabels,
  renderToolBody,
  maxOutputChars = DEFAULT_MAX_CHARS,
}: {
  steps: readonly TraceStep[];
  working?: boolean;
  toolLabels?: Readonly<Record<string, ToolLabelSpec>>;
  /** Optional custom body renderer inside a tool's expanded trace panel. */
  renderToolBody?: (call: TraceToolStep) => ReactNode | undefined;
  maxOutputChars?: number;
}) {
  const [open, setOpen] = useState<boolean>();
  if (steps.length === 0) return null;

  const rows = steps.map((step, i) =>
    step.type === "reasoning" ? (
      <ThinkingRow
        // biome-ignore lint/suspicious/noArrayIndexKey: reasoning steps are ordered sequentially within a turn
        key={`reasoning-${i}`}
        text={step.text}
        running={working && i === steps.length - 1}
      />
    ) : (
      <ToolCallRow
        key={step.id}
        call={step}
        known={toolLabels?.[step.name]}
        customBody={renderToolBody?.(step)}
        maxOutputChars={maxOutputChars}
      />
    ),
  );

  if (steps.length === 1) {
    return <Trace>{rows}</Trace>;
  }

  const tools = steps.filter((s): s is TraceToolStep => s.type === "tool");
  const failed = tools.filter(isFailedCall).length;
  const thought = steps.some((s) => s.type === "reasoning");
  const title = working
    ? "Working"
    : tools.length === 0
      ? "Thought"
      : `${thought ? "Thought and used" : "Used"} ${tools.length} tool${tools.length === 1 ? "" : "s"}`;

  return (
    <Trace>
      <TraceCollapsible open={open ?? working} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={working ? "running" : failed ? "error" : undefined}>
            <TraceIcon>
              {working ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : failed ? (
                <CircleAlertIcon />
              ) : (
                <CircleCheckIcon />
              )}
            </TraceIcon>
            <TraceTitle>{title}</TraceTitle>
            <TraceDescription>
              {failed ? `${failed} failed` : `${steps.length} steps`}
            </TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>{rows}</Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

function ThinkingRow({ text, running }: { text: string; running: boolean }) {
  const [open, setOpen] = useState<boolean>();
  return (
    <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine status={running ? "running" : undefined}>
          <TraceIcon>
            {running ? <LoaderCircleIcon className="animate-spin" /> : <CircleCheckIcon />}
          </TraceIcon>
          <TraceTitle>{running ? "Thinking" : "Thought"}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="whitespace-pre-wrap">{text}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function ToolCallRow({
  call,
  known,
  customBody,
  maxOutputChars,
}: {
  call: TraceToolStep;
  known?: ToolLabelSpec;
  customBody?: ReactNode;
  maxOutputChars: number;
}) {
  const input =
    call.input && typeof call.input === "object"
      ? (call.input as Record<string, unknown>)
      : undefined;
  const failed = isFailedCall(call);
  const Icon = !call.done
    ? LoaderCircleIcon
    : failed
      ? CircleAlertIcon
      : (known?.icon ?? WrenchIcon);
  const nameEl = <code className="font-mono text-[0.85em]">{call.name}</code>;
  const title = known ? (
    !call.done ? (
      known.doing
    ) : failed ? (
      known.failed
    ) : (
      known.done
    )
  ) : !call.done ? (
    <>Running {nameEl}</>
  ) : failed ? (
    <>{nameEl} failed</>
  ) : (
    <>Ran {nameEl}</>
  );
  const gistValue = known?.gist ? known.gist(input) : firstText(input);
  const gist = gistValue != null ? String(gistValue) : "";
  const shown =
    call.output !== undefined && call.output.length > maxOutputChars
      ? `${call.output.slice(0, maxOutputChars)}…`
      : call.output;

  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine status={!call.done ? "running" : failed ? "error" : undefined}>
          <TraceIcon>
            <Icon className={call.done ? undefined : "animate-spin"} />
          </TraceIcon>
          <TraceTitle>{title}</TraceTitle>
          {gist && (
            <TraceDescription className="max-w-48 truncate sm:max-w-80">{gist}</TraceDescription>
          )}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="grid gap-2">
        {customBody !== undefined ? (
          customBody
        ) : (
          <>
            <ToolOutput
              label="Input"
              text={
                call.inputPreview
                  ? `${call.inputPreview}…`
                  : JSON.stringify(call.input ?? {}, null, 2)
              }
            />
            {shown !== undefined && (
              <ToolOutput label={call.error ? "Error" : "Result"} text={shown} error={call.error} />
            )}
          </>
        )}
        {call.done && call.output === undefined && (
          <p className="text-sm text-destructive">The turn ended before this tool returned.</p>
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function ToolOutput({ label, text, error }: { label: string; text: string; error?: boolean }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <pre
        className={`max-h-64 overflow-auto rounded-md border p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words ${error ? "border-destructive/30 bg-destructive/5 text-destructive" : "bg-muted/50"}`}
      >
        {text}
      </pre>
    </div>
  );
}
