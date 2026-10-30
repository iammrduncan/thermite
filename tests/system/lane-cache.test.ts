import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type ClusterRigPlan, clusterRigObjects } from "../../src/control/clusters/manifests.ts";
import { type RigPlan, rigUnits } from "../../src/control/machines/deploy.ts";
import { laneCacheDir, laneCacheEnv } from "../../src/harness/agents/workspace.ts";
import {
  emptyScratchKeepingCaches,
  restoreLaneCaches,
} from "../../src/harness/broker/lane-caches.ts";

/**
 * A lane's cache folder lives under the harness's scratch folder (/scratch), so it survives a
 * restart wherever /scratch is on a volume that outlives the container (goal 079). These tests
 * hold Thermite's own deployments to that: compose, the release bundle's compose file, the units
 * of a rig on a machine, and the objects of a rig on a cluster.
 */

const repo = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** The harness services of a compose file and what each mounts at /scratch. */
function composeScratch(path: string): { service: string; mount: string }[] {
  const text = readFileSync(repo(path), "utf8");
  const out: { service: string; mount: string }[] = [];
  let service = "";
  for (const line of text.split("\n")) {
    const s = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (s) service = s[1] as string;
    const m = /^\s+-\s+"?([^:"\s]+):\/scratch"?\s*$/.exec(line);
    if (m) out.push({ service, mount: m[1] as string });
  }
  return out;
}

/** The top-level named volumes of a compose file. */
function composeVolumes(path: string): string[] {
  const text = readFileSync(repo(path), "utf8");
  const at = text.indexOf("\nvolumes:\n");
  assert.ok(at >= 0, `${path} names its volumes`);
  return [...text.slice(at).matchAll(/^ {2}([a-z0-9-]+):/gm)].map((m) => m[1] as string);
}

describe("a lane's cache folder survives a restart (goal 079)", () => {
  test("the broker empties the scratch folder at a start, but for each lane's own cache", () => {
    const scratch = mkdtempSync(join(tmpdir(), "thermite-scratch-"));
    const lanes = join(scratch, "thermite", "lanes");
    const put = (path: string, text = "x") => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    };
    put(join(lanes, "lane-1", "cache", "ccache", "a.o"), "object");
    put(join(lanes, "lane-1", "9f1c", "repo", "junk.c"));
    put(join(lanes, "lane-3", "cache", "b.o"));
    put(join(scratch, "thermite", "research", "r-1", "INDEX.md"));
    put(join(scratch, "elsewhere", "secret"));
    // A link where lane-2's cache should be: never followed, never kept.
    mkdirSync(join(lanes, "lane-2"), { recursive: true });
    symlinkSync(join(scratch, "elsewhere"), join(lanes, "lane-2", "cache"));
    // A folder that is no lane's.
    put(join(lanes, "lane-99", "cache", "c.o"));
    const kept = emptyScratchKeepingCaches(scratch, {
      // As the broker does by owner: here, lane-3's cache is not its lane's.
      keep: (lane) => lane !== "lane-3",
      remove: (path) => rmSync(path, { recursive: true, force: true }),
    });
    assert.deepEqual(kept, ["lane-1"]);
    assert.deepEqual(readdirSync(scratch), [".lane-caches"], "everything else went");
    // The broker makes its own folder again, then puts the caches back.
    mkdirSync(join(scratch, "thermite", "tmp"), { recursive: true });
    const owned: string[] = [];
    restoreLaneCaches(scratch, kept, (dir) => owned.push(dir));
    assert.equal(readFileSync(join(lanes, "lane-1", "cache", "ccache", "a.o"), "utf8"), "object");
    assert.ok(!existsSync(join(lanes, "lane-1", "9f1c")), "its old workspace went");
    assert.ok(!existsSync(join(lanes, "lane-2")), "a link is not a cache");
    assert.ok(!existsSync(join(lanes, "lane-3")), "a cache another user owns went");
    assert.ok(!existsSync(join(scratch, ".lane-caches")));
    assert.deepEqual(owned, [lanes, join(lanes, "lane-1")], "the new folders are the controller's");
    // A start that stopped half way left a cache aside: the next start puts it back.
    mkdirSync(join(scratch, ".lane-caches", "lane-4"), { recursive: true });
    writeFileSync(join(scratch, ".lane-caches", "lane-4", "d.o"), "y");
    const again = emptyScratchKeepingCaches(scratch, {
      keep: () => true,
      remove: (path) => rmSync(path, { recursive: true, force: true }),
    });
    assert.deepEqual(again, ["lane-1", "lane-4"]);
    mkdirSync(join(scratch, "thermite", "tmp"), { recursive: true });
    restoreLaneCaches(scratch, again, () => undefined);
    assert.ok(existsSync(join(lanes, "lane-4", "cache", "d.o")));
    assert.ok(existsSync(join(lanes, "lane-1", "cache", "ccache", "a.o")));
  });

  test("it lives under the scratch folder, kept across trials", () => {
    // Under the broker the harness works in /scratch/thermite (main.ts).
    assert.equal(
      laneCacheDir("/scratch/thermite", "lane-2"),
      "/scratch/thermite/lanes/lane-2/cache",
    );
    assert.equal(
      laneCacheEnv("/scratch/thermite", "lane-2").CCACHE_DIR,
      "/scratch/thermite/lanes/lane-2/cache",
    );
  });

  test("ccache rewrites paths under the lane's folder and leaves the build folder out of its hash (goal 144)", () => {
    const env = laneCacheEnv("/scratch/thermite", "lane-2");
    // Each trial's checkout is /scratch/thermite/lanes/lane-2/<random id>/repo.
    assert.equal(env.CCACHE_BASEDIR, "/scratch/thermite/lanes/lane-2");
    assert.equal(env.CCACHE_NOHASHDIR, "1");
  });

  const ccache = spawnSync("ccache", ["--version"]).status === 0;
  test("with it, a second trial's checkout in another folder hits what the first compiled", {
    skip: ccache ? false : "ccache is not installed here",
  }, () => {
    const scratch = mkdtempSync(join(tmpdir(), "thermite-ccache-"));
    try {
      const env = { ...process.env, ...laneCacheEnv(scratch, "lane-1") };
      const build = (trial: string) => {
        const repoDir = join(scratch, "lanes", "lane-1", trial, "repo");
        mkdirSync(join(repoDir, "src"), { recursive: true });
        mkdirSync(join(repoDir, "build"), { recursive: true });
        writeFileSync(join(repoDir, "src", "k.c"), "int k(int x) { return x * 3 + 1; }\n");
        // Absolute paths, as cmake writes them, from the same build folder of the checkout.
        const r = spawnSync(
          "ccache",
          ["cc", "-c", join(repoDir, "src", "k.c"), "-I", join(repoDir, "src"), "-o", "k.o"],
          { cwd: join(repoDir, "build"), env },
        );
        assert.equal(r.status, 0, String(r.stderr));
      };
      // ccache's counters, one "name<TAB>value" a line.
      const hits = () => {
        const out = spawnSync("ccache", ["--print-stats"], { env, encoding: "utf8" }).stdout;
        const n = (k: string) => Number(out.match(new RegExp(`^${k}\t(\\d+)$`, "m"))?.[1] ?? 0);
        return n("direct_cache_hit") + n("preprocessed_cache_hit");
      };
      build("a1b2c3");
      assert.equal(hits(), 0);
      build("d4e5f6");
      assert.equal(hits(), 1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  for (const file of ["compose.yaml", "containers/release/compose.template.yaml"])
    test(`${file}: each harness mounts a named volume at /scratch`, () => {
      const mounts = composeScratch(file);
      assert.ok(mounts.length >= 1, "a harness mounts /scratch");
      const named = composeVolumes(file);
      for (const m of mounts) {
        assert.match(m.service, /harness/);
        assert.ok(
          named.includes(m.mount),
          `${m.service}'s /scratch is the named volume ${m.mount}`,
        );
      }
    });

  test("a rig on a machine: its harness mounts its own scratch volume", () => {
    const plan: RigPlan = {
      rig: "box-1-a",
      controlUrl: "https://control.example.com/",
      images: { harness: "registry.example.com/h:1", supervisor: "registry.example.com/s:1" },
      gpus: [],
      root: false,
      controlPublicKey: "-----PUBLIC KEY-----\nabc\n",
      controlFingerprint: "sha256:abcd",
      bus: { url: "nats://control.example.com:4222", ca: "CA" },
    };
    const unit = rigUnits(plan)["thermite-box-1-a-harness.container"] ?? "";
    assert.match(unit, /^Volume=thermite-box-1-a-scratch:\/scratch$/m);
  });

  test("a rig on a cluster: /scratch is on its data volume, a persistent volume claim", () => {
    const plan: ClusterRigPlan = {
      rig: "k8s-a-1",
      placement: "created",
      namespace: "thermite-k8s-a-1",
      controlUrl: "https://control.example.com/",
      images: { harness: "registry.example.com/h:1", supervisor: "registry.example.com/s:1" },
      gpus: 0,
      gpuMode: "device-plugin",
      storageGi: 20,
      controlPublicKey: "PUBLIC KEY",
      bus: { url: "nats://control.example.com:4222", ca: "CA" },
    };
    type Obj = { kind: string; metadata: { name: string }; spec?: unknown };
    const objs = clusterRigObjects(plan, {
      controlToken: "t",
      harnessSupervisorToken: "s",
    }) as Obj[];
    const harness = objs.find(
      (o) => o.kind === "Deployment" && /harness/.test(o.metadata.name),
    ) as unknown as {
      spec: {
        template: {
          spec: {
            containers: {
              name: string;
              volumeMounts: { name: string; mountPath: string; subPath?: string }[];
            }[];
            volumes: { name: string; persistentVolumeClaim?: { claimName: string } }[];
          };
        };
      };
    };
    const pod = harness.spec.template.spec;
    const mount = pod.containers
      .find((c) => c.name === "harness")
      ?.volumeMounts.find((m) => m.mountPath === "/scratch");
    assert.deepEqual(mount, { name: "data", mountPath: "/scratch", subPath: "scratch" });
    const claim = pod.volumes.find((v) => v.name === "data")?.persistentVolumeClaim?.claimName;
    assert.ok(claim, "the data volume is a claim");
    assert.ok(
      objs.some((o) => o.kind === "PersistentVolumeClaim" && o.metadata.name === claim),
      "the claim is one of the rig's own objects",
    );
  });
});
