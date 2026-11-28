import { assertSubjectToken } from "./subjects.ts";

export type NatsAccountName = "THERMITE" | "SYS";
export type NatsDirection = "publish" | "subscribe";
export type NKeyPrincipalRole = "control" | "runner" | "live-reader" | "backup" | "system";
export type LiveReaderMode = "live_only" | "replay";
export type NatsAccountSpec = {
  readonly name: NatsAccountName;
  readonly jetstream: boolean;
  readonly description: string;
};
export type NatsPermissionSet = {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
};
export type NKeyPrincipalSpec = {
  readonly account: NatsAccountName;
  readonly name: string;
  readonly role: NKeyPrincipalRole;
  readonly publish: NatsPermissionSet;
  readonly subscribe: NatsPermissionSet;
};
export type LiveReaderPrincipalOptions = {
  readonly mode?: LiveReaderMode;
  readonly consumer?: string;
};

export const NATS_ACCOUNTS = {
  THERMITE: { name: "THERMITE", jetstream: true, description: "Thermite JetStream account." },
  SYS: { name: "SYS", jetstream: false, description: "NATS server system account." },
} as const satisfies Readonly<Record<NatsAccountName, NatsAccountSpec>>;

const mk = (
  account: NatsAccountName,
  name: string,
  role: NKeyPrincipalRole,
  pubAllow: readonly string[],
  subAllow: readonly string[],
  pubDeny: readonly string[] = [],
): NKeyPrincipalSpec => ({
  account,
  name,
  role,
  publish: { allow: pubAllow, deny: pubDeny },
  subscribe: { allow: subAllow, deny: [] },
});

const jsConsumer = (stream: "JOBS" | "LIVE", consumer: string): readonly string[] => [
  `$JS.API.CONSUMER.INFO.${stream}.${consumer}`,
  `$JS.API.CONSUMER.MSG.NEXT.${stream}.${consumer}`,
  `$JS.ACK.${stream}.${consumer}.>`,
];

export const controlPrincipal = (): NKeyPrincipalSpec =>
  mk("THERMITE", "control", "control", [">"], [">"], ["$JS.API.STREAM.DELETE.EVENTS"]);

export function runnerPrincipal(machineId: string): NKeyPrincipalSpec {
  const id = assertSubjectToken(machineId, "machineId");
  return mk(
    "THERMITE",
    `runner:${id}`,
    "runner",
    [
      `t.machine.${id}.hb`,
      `t.machine.${id}.job.result`,
      `t.machine.${id}.job.*.live`,
      ...jsConsumer("JOBS", `runner-${id}`),
    ],
    [`_INBOX.m.${id}.>`, `t.machine.${id}.cancel`],
  );
}

export function liveReaderPrincipal(opts?: LiveReaderPrincipalOptions): NKeyPrincipalSpec {
  if ((opts?.mode ?? "live_only") !== "replay") {
    return mk("THERMITE", "live-reader", "live-reader", [], ["t.live.>"]);
  }
  const c = assertSubjectToken(opts?.consumer ?? "", "consumer");
  return mk("THERMITE", `live-reader:${c}`, "live-reader", jsConsumer("LIVE", c), [
    `_INBOX.live.${c}.>`,
  ]);
}

export const backupPrincipal = (): NKeyPrincipalSpec =>
  mk(
    "THERMITE",
    "backup",
    "backup",
    [
      ...["INFO", "MSG.GET", "SNAPSHOT", "RESTORE"].map((op) => `$JS.API.STREAM.${op}.EVENTS`),
      "$JS.SNAPSHOT.ACK.EVENTS.>",
      "$JS.SNAPSHOT.RESTORE.EVENTS.>",
    ],
    ["_INBOX.backup.>"],
  );

export const systemPrincipal = (): NKeyPrincipalSpec =>
  mk(
    "SYS",
    "system",
    "system",
    ["RELOAD", "VARZ", "CONNZ", "JSZ"].map((op) => `$SYS.REQ.SERVER.*.${op}`),
    ["_INBOX.>"],
  );

function parseNatsTokens(value: string): readonly string[] | null {
  if (!value || /[\s\p{Cc}]/u.test(value)) return null;
  const tokens = value.split(".");
  const invalid = (tok: string, i: number) =>
    !tok ||
    (tok === ">"
      ? i !== tokens.length - 1
      : tok.includes(">") || (tok !== "*" && tok.includes("*")));
  return tokens.some(invalid) ? null : tokens;
}

export function matchesNatsSubject(pattern: string, subject: string): boolean {
  const pTokens = parseNatsTokens(pattern);
  const sTokens = parseNatsTokens(subject);
  if (!pTokens || !sTokens) return false;
  for (let i = 0; i < pTokens.length; i++) {
    const p = pTokens[i];
    if (p === ">") return i < sTokens.length;
    if (i >= sTokens.length || (p === "*" ? sTokens[i] === ">" : p !== sTokens[i])) return false;
  }
  return pTokens.length === sTokens.length;
}

export function isPrincipalAllowed(
  principal: NKeyPrincipalSpec,
  direction: NatsDirection,
  subject: string,
): boolean {
  const tokens = parseNatsTokens(subject);
  if (!tokens) return false;
  if (direction === "publish" && tokens.some((tok) => tok === "*" || tok === ">")) return false;
  const { allow, deny } = principal[direction];
  return (
    allow.some((p) => matchesNatsSubject(p, subject)) &&
    !deny.some((p) => matchesNatsSubject(p, subject))
  );
}
