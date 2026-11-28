import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import {
  compareSemver,
  createDoorExecutor,
  createGrantFromProfile,
  createPluginHost,
  DEFAULT_PLUGIN_BREAKS,
  type DomainEvent,
  defineAction,
  definePluginAction,
  isThermiteError,
  type JudgePlugin,
  PLUGIN_UI_SLOTS,
  type PluginBreakRule,
  type PolicyGrant,
  parsePluginManifest,
  pluginSchemaName,
  unfit,
  type WallPlugin,
  type WallSelfTestTargets,
} from "../src/index.ts";

function makeManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: "git-sync",
    version: "1.0.0",
    description: "Automatic Git champion synchronization.",
    license: "Apache-2.0",
    extensions: {
      "com.usethermite": {
        minThermite: "1.0.0",
        control: "./thermite/control.ts",
        settings: [
          { name: "remote", description: "Git remote name", default: "origin" },
          { name: "token", description: "Git auth token", secret: true },
        ],
        needs: {},
        uiSlots: ["run.header.action", "setup.section"],
      },
    },
    ...overrides,
  };
}

test("manifest validates com.usethermite, preserves sibling sh.fxbot, and enforces slug/slot/path bounds", () => {
  const dual = parsePluginManifest({
    name: "web-pairing",
    version: "0.2.1",
    description: "Pair browsers over encrypted WebRTC.",
    license: "Apache-2.0",
    extensions: {
      "com.usethermite": {
        minThermite: "1.0.0-alpha.0",
        control: "./thermite/control.ts",
        runner: "./thermite/runner.ts",
        page: "./thermite/page.js",
        css: "./thermite/page.css",
        migrations: "./thermite/migrations",
        settings: [
          { name: "relay", description: "Signaling relay URL", default: "wss://example.test" },
        ],
        needs: { "base-auth": ">=1.0.0", "optional-ui": { optional: true, range: "^1.0.0" } },
        uiSlots: [...PLUGIN_UI_SLOTS],
      },
      "sh.fxbot": {
        minFxbot: "0.12.0",
        server: "./fxbot/server.ts",
      },
    },
  });

  assert.equal(dual.name, "web-pairing");
  assert.equal(dual.extensions["com.usethermite"].minThermite, "1.0.0-alpha.0");
  assert.deepEqual(dual.extensions["sh.fxbot"], {
    minFxbot: "0.12.0",
    server: "./fxbot/server.ts",
  });
  assert.equal(PLUGIN_UI_SLOTS.length, 6);
  assert.equal(pluginSchemaName("web-pairing"), "plugin_web_pairing");
  assert.equal(pluginSchemaName("knowledge-semantic"), "plugin_knowledge_semantic");

  // Reject invalid plugin slugs
  for (const badSlug of ["WebPairing", "1plugin", "bad_slug", "bad slug", ""]) {
    assert.throws(
      () => parsePluginManifest(makeManifest({ name: badSlug })),
      (err) => isThermiteError(err) && err.code === "VALIDATION_ERROR",
    );
    assert.throws(
      () => pluginSchemaName(badSlug),
      (err) => isThermiteError(err) && err.code === "VALIDATION_ERROR",
    );
  }

  // Reject disallowed UI slots outside the 6 bounded slots
  assert.throws(
    () =>
      parsePluginManifest(
        makeManifest({
          extensions: {
            "com.usethermite": {
              minThermite: "1.0.0",
              uiSlots: ["home.banner"],
            },
          },
        }),
      ),
    (err) => isThermiteError(err) && err.code === "VALIDATION_ERROR",
  );

  // Reject absolute or parent-traversal paths
  for (const badPath of ["/etc/passwd", "../escape.ts", "./a/../../b.ts"]) {
    assert.throws(
      () =>
        parsePluginManifest(
          makeManifest({
            extensions: {
              "com.usethermite": { minThermite: "1.0.0", control: badPath },
            },
          }),
        ),
      (err) => isThermiteError(err) && err.code === "VALIDATION_ERROR",
    );
  }
});

test("compareSemver and unfit handle prereleases, minThermite, and plugin-breaks rules", () => {
  assert.equal(compareSemver("1.0.0-alpha.0", "1.0.0-alpha.1"), -1);
  assert.equal(compareSemver("1.0.0-alpha.1", "1.0.0-beta.0"), -1);
  assert.equal(compareSemver("1.0.0-beta.0", "1.0.0"), -1);
  assert.equal(compareSemver("1.0.0", "1.0.0-alpha.0"), 1);
  assert.equal(compareSemver("1.0.0+build.1", "1.0.0+build.2"), 0);
  assert.equal(compareSemver("1.2.0", "1.10.0"), -1);

  const m100 = parsePluginManifest(makeManifest());
  const mAlpha = parsePluginManifest(
    makeManifest({
      extensions: { "com.usethermite": { minThermite: "1.0.0-alpha.0" } },
    }),
  );

  // minThermite check with prerelease awareness
  assert.equal(unfit(mAlpha, null, "1.0.0-alpha.0"), null);
  assert.equal(unfit(mAlpha, null, "1.0.0"), null);
  const tooOld = unfit(m100, null, "1.0.0-alpha.0");
  assert.equal(tooOld?.kind, "min_thermite");

  const rules: PluginBreakRule[] = [
    {
      id: "break-legacy-hook",
      since: "1.1.0",
      pattern: "\\bt\\.legacyHook\\s*\\(",
      reason: "t.legacyHook() was removed in Thermite 1.1.0",
      removedHook: "legacyHook",
    },
    {
      id: "break-v2-api",
      since: "2.0.0",
      reason: "PluginApi v2 requires plugins targeting >= 2.0.0",
    },
  ];

  // Before rule.since: still fit even if code matches pattern
  assert.equal(unfit(m100, "t.legacyHook()", "1.0.5", rules), null);

  // At/after rule.since: code pattern triggers break_rule
  const codeHit = unfit(m100, "export default (t) => t.legacyHook();", "1.1.0", rules);
  assert.deepEqual(codeHit, {
    kind: "break_rule",
    ruleId: "break-legacy-hook",
    reason: "t.legacyHook() was removed in Thermite 1.1.0",
  });

  // Clean code passes pattern rule
  assert.equal(
    unfit(m100, "export default (t) => t.onEvent('*', () => {});", "1.1.0", rules),
    null,
  );

  // Version-range rule (no pattern) rejects manifest with minThermite < 2.0.0 on host 2.0.0
  const rangeHit = unfit(m100, null, "2.0.0", rules);
  assert.deepEqual(rangeHit, {
    kind: "break_rule",
    ruleId: "break-v2-api",
    reason: "PluginApi v2 requires plugins targeting >= 2.0.0",
  });

  // Updated manifest with minThermite >= 2.0.0 passes version-range rule
  const m200 = parsePluginManifest(
    makeManifest({ extensions: { "com.usethermite": { minThermite: "2.0.0" } } }),
  );
  assert.equal(unfit(m200, null, "2.0.0", rules), null);

  // On-disk plugin-breaks.json matches expected structure and DEFAULT_PLUGIN_BREAKS
  const onDisk = JSON.parse(
    readFileSync(new URL("../src/plugin/plugin-breaks.json", import.meta.url), "utf8"),
  ) as { version: string; breaks: PluginBreakRule[] };
  assert.equal(onDisk.version, "1.0.0");
  assert.deepEqual(onDisk.breaks, DEFAULT_PLUGIN_BREAKS);
});

test("createPluginHost enforces compatibility, needs/provide/dependents, and event fanout", async () => {
  const host = createPluginHost({
    thermiteVersion: "1.0.0",
    callAction: async () => {
      throw new Error("unused");
    },
  });

  // Rejects unfit plugin on load
  await assert.rejects(
    () =>
      host.load({
        manifest: makeManifest({
          name: "future-plugin",
          extensions: { "com.usethermite": { minThermite: "2.0.0" } },
        }),
        setup: () => {},
      }),
    (err) => isThermiteError(err) && err.code === "VALIDATION_ERROR",
  );

  // Rejects missing required dependency
  await assert.rejects(
    () =>
      host.load({
        manifest: makeManifest({
          name: "consumer-plugin",
          extensions: {
            "com.usethermite": { minThermite: "1.0.0", needs: { "provider-plugin": ">=1.0.0" } },
          },
        }),
        setup: () => {},
      }),
    (err) => isThermiteError(err) && err.code === "VALIDATION_ERROR",
  );

  let providerApiHandle: { dependents: () => readonly { name: string }[] } | null = null;
  await host.load({
    manifest: makeManifest({ name: "provider-plugin", version: "1.2.0" }),
    setup: (t) => {
      assert.equal(t.settings.remote, "origin");
      t.provide({ greet: (who: string) => `hi ${who}` });
      providerApiHandle = { dependents: () => t.dependents() };
    },
  });

  const seenEvents: string[] = [];
  let greeted = "";
  let missingOptional: unknown = "unset";
  await host.load({
    manifest: makeManifest({
      name: "consumer-plugin",
      version: "1.0.0",
      extensions: {
        "com.usethermite": {
          minThermite: "1.0.0",
          needs: {
            "provider-plugin": "^1.0.0",
            "absent-optional": { optional: true, range: ">=1.0.0" },
          },
        },
      },
    }),
    setup: (t) => {
      const provider = t.need<{ greet: (who: string) => string }>("provider-plugin");
      assert.ok(provider);
      greeted = provider.greet("thermite");
      missingOptional = t.need("absent-optional");
      t.onEvent("attempt.promoted", (ev) => {
        seenEvents.push(`promoted:${ev.attemptId}`);
      });
      t.onEvent("*", (ev) => {
        seenEvents.push(`all:${ev.type}`);
      });
    },
  });

  assert.equal(greeted, "hi thermite");
  assert.equal(missingOptional, null);
  assert.ok(providerApiHandle);
  assert.deepEqual(
    (providerApiHandle as { dependents: () => readonly { name: string }[] })
      .dependents()
      .map((d) => d.name),
    ["consumer-plugin"],
  );

  const promotedEvent: DomainEvent = {
    type: "attempt.promoted",
    runId: "r1",
    attemptId: "a7",
    commitRef: "abc123",
    metricDelta: 0.12,
    actor: { principalId: "owner-1", principalKind: "owner_session" },
  };
  await host.emitEvent(promotedEvent);
  assert.deepEqual(seenEvents, ["promoted:a7", "all:attempt.promoted"]);
});

test("createPluginHost enforces capability namespace, mounts routes/sockets, and integrates with Door", async () => {
  const door = createDoorExecutor({ handlers: {} });
  const host = createPluginHost({
    thermiteVersion: "1.0.0",
    callAction: async (name, input, grant) =>
      door.execute(name, input, { principalId: "plugin:git-sync", grant, nowMs: 1_000 }),
    registerPluginActions: (pluginName, bindings) =>
      door.registerPluginActions(pluginName, bindings),
    unregisterPluginActions: (pluginName) => door.unregisterPluginActions(pluginName),
  });

  // Rejects action claiming core or wrong-plugin capability namespace
  await assert.rejects(
    () =>
      host.load({
        manifest: makeManifest({ name: "rogue-plugin" }),
        setup: (t) => {
          const badDef = defineAction({
            name: "rogue.steal",
            summary: "Attempt to claim core capability",
            capability: "runs:write",
            http: { method: "POST", path: "/v1/plugins/rogue-plugin/steal" },
            input: z.object({}),
            output: z.object({ ok: z.boolean() }),
          });
          t.registerActions([definePluginAction(badDef, () => ({ ok: true }))]);
        },
      }),
    (err) => isThermiteError(err) && err.code === "VALIDATION_ERROR",
  );
  assert.equal(host.getPlugin("rogue-plugin"), null);

  // Rejects intra-batch duplicate action names
  await assert.rejects(
    () =>
      host.load({
        manifest: makeManifest({ name: "dup-plugin" }),
        setup: (t) => {
          const def = defineAction({
            name: "dup.ping",
            summary: "Duplicate test action",
            capability: "dup-plugin:ping",
            http: { method: "POST", path: "/v1/plugins/dup-plugin/ping" },
            input: z.object({}),
            output: z.object({ ok: z.boolean() }),
          });
          t.registerActions([
            definePluginAction(def, () => ({ ok: true })),
            definePluginAction(def, () => ({ ok: true })),
          ]);
        },
      }),
    (err) => isThermiteError(err) && err.code === "CONFLICT",
  );
  assert.equal(host.getPlugin("dup-plugin"), null);

  // Valid plugin registers namespaced action + route + socket
  await host.load({
    manifest: makeManifest({ name: "git-sync" }),
    setup: (t) => {
      const syncDef = defineAction({
        name: "git.sync_now",
        summary: "Sync champion commit to Git remote",
        capability: "git-sync:sync",
        http: { method: "POST", path: "/v1/plugins/git-sync/sync" },
        input: z.object({ runId: z.string().min(1) }),
        output: z.object({ synced: z.boolean(), runId: z.string() }),
      });
      t.registerActions([
        definePluginAction(syncDef, (input) => ({ synced: true, runId: input.runId })),
      ]);
      t.route("get", "/status", () => ({ status: 200, body: { ok: true } }));
      t.socket("/events", () => {});
    },
  });

  const route = host.routes.get("GET /v1/plugins/git-sync/status");
  assert.ok(route);
  assert.equal(route.fullPath, "/v1/plugins/git-sync/status");
  const sock = host.sockets.get("/v1/plugins/git-sync/events");
  assert.ok(sock);
  assert.equal(sock.fullPath, "/v1/plugins/git-sync/events");

  const delegateGrant = createGrantFromProfile({
    profile: "autonomous_delegate",
    id: "g-del",
    label: "delegate",
    grantedBy: "owner-1",
  });
  const syncResult = await door.execute(
    "git.sync_now",
    { runId: "run-42" },
    { principalId: "agent-1", grant: delegateGrant, nowMs: 2_000 },
  );
  assert.deepEqual(syncResult, { synced: true, runId: "run-42" });
});

test("createPluginHost gates WallPlugin and JudgePlugin behind proof checks and wires KB hooks", async () => {
  const host = createPluginHost({
    thermiteVersion: "1.0.0",
    callAction: async () => {
      throw new Error("unused");
    },
  });

  let wallShouldPass = false;
  let judgeShouldPass = false;
  const indexedEvents: number[] = [];

  const mockWall: WallPlugin = {
    id: "wall-test",
    version: "1.0.0",
    capabilities: { boundary: "os", localShell: true, externalCli: true, networkProxy: true },
    async probeAvailable() {
      return { ok: true };
    },
    async createZone() {
      throw new Error("not needed in proof test");
    },
    async selfTest(targets) {
      return {
        ok: wallShouldPass,
        wallId: "wall-test",
        boundary: "os",
        probes: { secretFile: wallShouldPass ? "refused" : `ALLOWED ${targets.secretFile}` },
        skipped: [],
      };
    },
  };

  const mockJudge: JudgePlugin = {
    id: "judge-stat",
    version: "1.2.3",
    async calibrateAA() {
      return {
        ok: judgeShouldPass,
        judgePlugin: "judge-stat",
        judgeVersion: "1.2.3",
        sampleCount: 20,
        falsePositiveRate: judgeShouldPass ? 0.02 : 0.45,
      };
    },
    async evaluate(ctx) {
      return {
        verdict: { outcome: "improve", metricDelta: 0.25, summary: `eval ${ctx.attemptId}` },
        judgePlugin: "judge-stat",
        judgeVersion: "1.2.3",
      };
    },
  };

  await host.load({
    manifest: makeManifest({ name: "proof-suite" }),
    setup: (t) => {
      t.registerWall(mockWall);
      t.registerJudge(mockJudge);
      t.kb.registerSearchLane({
        name: "semantic",
        weight: 1.0,
        async search() {
          return [{ itemId: 1, score: 0.91 }];
        },
      });
      t.kb.registerExtractor({
        mimeTypes: ["application/pdf"],
        async extract() {
          return { text: "extracted pdf", pages: 2 };
        },
      });
      t.kb.onItemIndexed(async (ev) => {
        indexedEvents.push(ev.itemId);
      });
    },
  });

  // Unverified until selfTest / calibrateAA pass
  assert.equal(host.getVerifiedWall("wall-test"), null);
  assert.equal(host.getVerifiedJudge("judge-stat"), null);

  const targets: WallSelfTestTargets = {
    secretFile: "/tmp/secret.key",
    stateDir: "/tmp/state",
    siblingDir: "/tmp/sibling",
    blockedTcp: [{ host: "127.0.0.1", port: 5432 }],
  };

  const failedWall = await host.verifyWall("wall-test", targets);
  assert.equal(failedWall.ok, false);
  assert.equal(host.getVerifiedWall("wall-test"), null);

  wallShouldPass = true;
  const passedWall = await host.verifyWall("wall-test", targets);
  assert.equal(passedWall.ok, true);
  assert.equal(host.getVerifiedWall("wall-test")?.id, "wall-test");

  const failedJudge = await host.verifyJudge("judge-stat");
  assert.equal(failedJudge.ok, false);
  assert.equal(host.getVerifiedJudge("judge-stat"), null);

  judgeShouldPass = true;
  const passedJudge = await host.verifyJudge("judge-stat");
  assert.equal(passedJudge.ok, true);
  const verifiedJudge = host.getVerifiedJudge("judge-stat");
  assert.ok(verifiedJudge);
  const evalResult = await verifiedJudge.evaluate({
    runId: "r1",
    attemptId: "a1",
    mode: "hill_climb",
  });
  assert.equal(evalResult.judgePlugin, "judge-stat");
  assert.equal(evalResult.judgeVersion, "1.2.3");
  assert.equal(evalResult.verdict.outcome, "improve");

  // KB hooks
  assert.deepEqual([...host.kb.lanes.keys()], ["semantic"]);
  assert.equal(host.kb.extractors.length, 1);
  await host.emitKbItemIndexed({ itemId: 99, collectionId: "c1", version: 1 });
  assert.deepEqual(indexedEvents, [99]);
});

test("createPluginHost forwards verified grants only and cleans up everything on unload", async () => {
  const verifiedGrants = new WeakSet<PolicyGrant>();
  const recordedCalls: { name: string; grantId: string | null; caps: readonly string[] }[] = [];

  const host = createPluginHost({
    thermiteVersion: "1.0.0",
    verifyGrant: (g) => verifiedGrants.has(g),
    callAction: async (name, _input, grant) => {
      recordedCalls.push({
        name,
        grantId: grant?.id ?? null,
        caps: grant ? [...grant.capabilities] : [],
      });
      return { runs: [] } as never;
    },
  });

  const mutablePluginGrant = {
    id: "g-plugin",
    label: "git-sync-grant",
    principalKind: "operator_token" as const,
    capabilities: ["runs:read" as const],
    grantedBy: "owner-1",
  };
  const callerGrant = createGrantFromProfile({
    profile: "operator",
    id: "g-caller",
    label: "caller",
    grantedBy: "owner-1",
  });
  verifiedGrants.add(callerGrant);

  const forgedGrant: PolicyGrant = {
    id: "g-forged",
    label: "self-minted",
    principalKind: "owner_session",
    capabilities: ["*"],
    grantedBy: "rogue",
  };

  const captured: {
    signal: AbortSignal | null;
    callAction: ((grant?: PolicyGrant) => Promise<unknown>) | null;
  } = { signal: null, callAction: null };
  let cleanedUp = false;
  let eventsAfterUnload = 0;

  await host.load({
    manifest: makeManifest({ name: "grant-test" }),
    pluginGrant: mutablePluginGrant,
    setup: (t) => {
      captured.signal = t.signal;
      captured.callAction = (g) => t.callAction("runs.list", {}, g);
      t.onEvent("*", () => {
        eventsAfterUnload += 1;
      });
      t.route("GET", "/ping", () => ({ status: 200 }));
      t.socket("/ws", () => {});
      t.kb.registerSearchLane({
        name: "temp-lane",
        async search() {
          return [];
        },
      });
      t.registerHarness({
        id: "h-temp",
        name: "Temp",
        version: "1.0.0",
        capabilities: {
          tools: "host_fn",
          steering: "none",
          durableResume: false,
          interactiveTerminal: false,
          compactionControl: "native_only",
          supportsResearch: false,
        },
        supportsAuth: () => true,
        openSession: async () => {
          throw new Error("unused");
        },
      });
      return async () => {
        cleanedUp = true;
      };
    },
  });

  // Attempt to mutate original pluginGrant array after load cannot escalate capabilities
  (mutablePluginGrant.capabilities as string[]).push("*");
  const callAction = captured.callAction;
  assert.ok(callAction);
  await callAction();
  assert.deepEqual(recordedCalls.at(-1), {
    name: "runs.list",
    grantId: "g-plugin",
    caps: ["runs:read"],
  });

  // Verified callerGrant is forwarded
  await callAction(callerGrant);
  assert.equal(recordedCalls.at(-1)?.grantId, "g-caller");

  // Forged self-minted grant is rejected
  await assert.rejects(
    () => callAction(forgedGrant),
    (err) => isThermiteError(err) && err.code === "FORBIDDEN",
  );

  // Revoked verified grant is rejected
  const revokedGrant: PolicyGrant = { ...callerGrant, revoked: true };
  verifiedGrants.add(revokedGrant);
  await assert.rejects(
    () => callAction(revokedGrant),
    (err) => isThermiteError(err) && err.code === "UNAUTHORIZED",
  );

  // Unload aborts signal, runs cleanup, clears all registries, and blocks subsequent calls
  assert.ok(captured.signal);
  assert.equal(captured.signal.aborted, false);
  await host.unload("grant-test");
  assert.equal(captured.signal.aborted, true);
  assert.equal(cleanedUp, true);
  assert.equal(host.getPlugin("grant-test"), null);
  assert.equal(host.routes.size, 0);
  assert.equal(host.sockets.size, 0);
  assert.equal(host.kb.lanes.size, 0);
  assert.equal(host.harnesses.size, 0);

  await host.emitEvent({ type: "clock.tick", now: 123 });
  assert.equal(eventsAfterUnload, 0);

  await assert.rejects(
    () => callAction(),
    (err) => isThermiteError(err) && err.code === "FORBIDDEN",
  );

  // Fail-closed: host without verifyGrant MUST reject any callerGrant
  const strictHost = createPluginHost({
    thermiteVersion: "1.0.0",
    callAction: async () => ({ runs: [] }) as never,
  });
  let strictCall: ((g?: PolicyGrant) => Promise<unknown>) | null = null;
  await strictHost.load({
    manifest: makeManifest({ name: "no-verifier-plugin" }),
    pluginGrant: mutablePluginGrant,
    setup: (t) => {
      strictCall = (g) => t.callAction("runs.list", {}, g);
    },
  });
  assert.ok(strictCall);
  await (strictCall as (g?: PolicyGrant) => Promise<unknown>)(); // host-issued pluginGrant still works
  await assert.rejects(
    () => (strictCall as (g?: PolicyGrant) => Promise<unknown>)(callerGrant),
    (err) => isThermiteError(err) && err.code === "FORBIDDEN",
  );
});

test("createPluginHost wires device/compute registries, rolls back failed setup, and validates dep ranges", async () => {
  const host = createPluginHost({
    thermiteVersion: "1.0.0",
    callAction: async () => {
      throw new Error("unused");
    },
  });

  await host.load({
    manifest: makeManifest({ name: "base-lib", version: "1.0.0" }),
    setup: () => {},
  });

  // Dependency range mismatch rejected
  await assert.rejects(
    () =>
      host.load({
        manifest: makeManifest({
          name: "needs-newer",
          extensions: {
            "com.usethermite": { minThermite: "1.0.0", needs: { "base-lib": ">=2.0.0" } },
          },
        }),
        setup: () => {},
      }),
    (err) => isThermiteError(err) && err.code === "VALIDATION_ERROR",
  );

  // Partial registrations before setup throws are rolled back cleanly
  await assert.rejects(
    () =>
      host.load({
        manifest: makeManifest({ name: "broken-init" }),
        setup: (t) => {
          t.route("GET", "/partial", () => ({ status: 200 }));
          throw new Error("boom during setup");
        },
      }),
    /boom during setup/,
  );
  assert.equal(host.getPlugin("broken-init"), null);
  assert.equal(host.routes.get("GET /v1/plugins/broken-init/partial"), undefined);

  // Device + Compute plugins register and clean up on unload
  await host.load({
    manifest: makeManifest({ name: "hw-bundle" }),
    setup: async (t) => {
      await t.secrets.set("api-key", "secret-val");
      assert.equal(await t.secrets.get("api-key"), "secret-val");
      await t.secrets.set("api-key", null);
      assert.equal(await t.secrets.get("api-key"), null);

      t.registerDevice({
        id: "device-cpu",
        version: "1.0.0",
        probe: async () => [{ id: "cpu0", kind: "cpu", name: "Host CPU" }],
        allocate: async (deviceIds) => ({ deviceIds, env: {}, release: async () => {} }),
        checkDrained: async () => ({ drained: true }),
        measure: async () => ({ ok: true, metrics: { gflops: 42 } }),
      });
      t.registerCompute({
        id: "compute-ssh",
        version: "1.0.0",
        discover: async () => [{ id: "n1", label: "Node 1", kind: "ssh", available: true }],
        provision: async (spec) => ({
          instanceId: "inst-1",
          targetId: spec.targetId,
          status: "running",
        }),
        enroll: async () => ({ machineId: "m-1" }),
        terminate: async () => {},
      });
    },
  });

  assert.equal(host.devices.get("device-cpu")?.id, "device-cpu");
  assert.equal(host.computes.get("compute-ssh")?.id, "compute-ssh");
  await host.unload("hw-bundle");
  assert.equal(host.devices.get("device-cpu"), undefined);
  assert.equal(host.computes.get("compute-ssh"), undefined);
});

test("packages/core/src/plugin stays pure (zero node:/db/nats imports, zero legacy topology terms)", () => {
  const pluginDir = new URL("../src/plugin/", import.meta.url).pathname;
  const files = readdirSync(pluginDir).filter((f) => f.endsWith(".ts") || f.endsWith(".json"));
  assert.ok(files.length >= 8);
  const forbiddenImportRe = /from\s+["'](?:node:|pg|postgres|@nats-io\/)/;
  const bannedTermRe = new RegExp(`\\b${"ri"}gs?\\b`, "i");

  for (const file of files) {
    const src = readFileSync(join(pluginDir, file), "utf8");
    assert.equal(
      forbiddenImportRe.test(src),
      false,
      `${file} must not import node:*, pg, postgres, or @nats-io/*`,
    );
    assert.equal(bannedTermRe.test(src), false, `${file} must not contain legacy topology terms`);
  }
});
