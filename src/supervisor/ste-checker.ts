import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { SteResult } from "../core/api/harness/research.ts";
import { sha256Hex } from "../core/canonical.ts";

/**
 * The Simplified Technical English checker a deployment gives its supervisor (goal 112), for the
 * final writer's research papers. Thermite ships no checker and no vocabulary: ASD-STE100's
 * notice forbids redistributing the standard. A deployment that has one sets
 * THERMITE_STE_CHECKER to its script, a program run as `node <path> --json --mode descriptive -`
 * with the text on its standard input, which prints its findings as one JSON object:
 * `{version, issue, counts: {error, warning, info}, findings: [{path, line, column, severity,
 * rule, message, text}]}`, and exits with 0, or 1 when it found an error. Its guide, when there is
 * one, is `reference/ste-guide.md` beside the script's folder; the writer's prompt carries it.
 *
 * The supervisor runs the checker itself on the paper it posts, never the model: its result goes
 * to the harness with the paper, which refuses a paper the checker found an error in.
 */

/** Why a paper's style was not checked, on a rig whose supervisor has no checker. */
export const NO_STE_CHECKER = "the rig has no STE checker";

/** The most characters of the guide a writer's prompt carries. */
const GUIDE_MAX = 60_000;

/** The checker's own answer, as it prints it with --json (other fields are left out). */
const SteOutput = z.object({
  version: z.unknown().optional(),
  issue: z.unknown().optional(),
  counts: z.object({
    error: z.number().int().min(0),
    warning: z.number().int().min(0),
    info: z.number().int().min(0).default(0),
  }),
  findings: z
    .array(
      z.object({
        line: z.number().int().min(0),
        column: z.number().int().min(0).optional(),
        severity: z.string().max(20),
        rule: z.coerce.string().max(100),
        message: z.string().max(1000),
        text: z.string().default(""),
      }),
    )
    .default([]),
});

export interface SteReport {
  version: string | null;
  issue: string | null;
  counts: { error: number; warning: number; info: number };
  /** Errors first, then warnings and notes, each at most 500 characters of text. */
  findings: {
    line: number;
    column?: number | undefined;
    severity: string;
    rule: string;
    message: string;
    text: string;
  }[];
}

export interface SteChecker {
  /** The script, as the setting names it, made absolute. */
  path: string;
  /** Its guide, when `reference/ste-guide.md` is beside the script's folder. */
  guide: string | undefined;
  /** Runs the checker on a text (descriptive mode). */
  check(text: string): Promise<SteReport>;
}

const asText = (v: unknown) =>
  v === undefined || v === null ? null : String(v).slice(0, 100) || null;

/** The checker at `path` (THERMITE_STE_CHECKER), or undefined when the rig has none. */
export function steCheckerAt(
  path: string | undefined,
  o: { timeoutMs?: number | undefined } = {},
): SteChecker | undefined {
  if (!path?.trim()) return undefined;
  const script = resolve(path.trim());
  const guidePath = join(dirname(dirname(script)), "reference", "ste-guide.md");
  let guide: string | undefined;
  try {
    if (existsSync(guidePath)) guide = readFileSync(guidePath, "utf8").slice(0, GUIDE_MAX);
  } catch {
    guide = undefined; // a guide that cannot be read: the prompt's short rules instead
  }
  const timeoutMs = o.timeoutMs ?? 120_000;
  return {
    path: script,
    guide,
    check: (text) => runChecker(script, text, timeoutMs),
  };
}

function runChecker(script: string, text: string, timeoutMs: number): Promise<SteReport> {
  return new Promise((resolveRun, reject) => {
    if (!existsSync(script)) {
      reject(new Error(`no STE checker at ${script} (THERMITE_STE_CHECKER)`));
      return;
    }
    const child = spawn(process.execPath, [script, "--json", "--mode", "descriptive", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the STE checker gave no answer in ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // 0: no error found; 1: errors found. Anything else: the checker failed.
      if (code !== 0 && code !== 1) {
        reject(new Error(`the STE checker exited with ${code}: ${err.trim().slice(0, 300)}`));
        return;
      }
      let parsed: z.infer<typeof SteOutput>;
      try {
        parsed = SteOutput.parse(JSON.parse(out));
      } catch {
        reject(
          new Error(
            `the STE checker gave no JSON report (exit ${code}): ${(err.trim() || out.trim()).slice(0, 300)}`,
          ),
        );
        return;
      }
      const rank = (s: string) => (s === "error" ? 0 : s === "warning" ? 1 : 2);
      resolveRun({
        version: asText(parsed.version),
        issue: asText(parsed.issue),
        counts: parsed.counts,
        findings: [...parsed.findings]
          .sort((a, b) => rank(a.severity) - rank(b.severity) || a.line - b.line)
          .map((f) => ({ ...f, message: f.message.slice(0, 1000), text: f.text.slice(0, 500) })),
      });
    });
    child.stdin.on("error", () => {
      // the checker closed its input early: its exit says what happened
    });
    child.stdin.end(text);
  });
}

/** The checker's report, as the final writer's ste_check tool gives it: the first 100 findings. */
export function steToolAnswer(r: SteReport): unknown {
  return {
    checked: true,
    counts: r.counts,
    findings: r.findings.slice(0, 100),
    ...(r.findings.length > 100 ? { more_findings: r.findings.length - 100 } : {}),
  };
}

/** The checker's report on a paper's text, as the supervisor posts it with the paper. */
export function steResultOf(r: SteReport, paper: string): SteResult {
  return {
    checked: true,
    sha256: sha256Hex(paper),
    version: r.version,
    issue: r.issue,
    counts: r.counts,
    findings: r.findings.slice(0, 200),
  };
}
