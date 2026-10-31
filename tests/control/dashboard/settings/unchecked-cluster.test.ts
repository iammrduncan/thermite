import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { control, fakeCluster, KUBECONFIG } from "../../../helpers/fake-cluster.ts";

/**
 * A kubeconfig whose connection control can't check (it skips TLS checks, or names a plain http
 * server) is refused, unless the owner ticks that they accept it; the cluster's row says so then.
 */

describe("a cluster whose connection control can't check", () => {
  test("refused in words without the tick; added with it, and its row shows the owner accepted", async () => {
    const f = fakeCluster();
    const s = await control(f.k);
    const add = (name: string, kubeconfig: string, more: Record<string, string> = {}) =>
      s.post("/ui/settings/add", { type: "k8s", name, kubeconfig, placement: "created", ...more });
    const page = await s.page("/ui/settings");
    assert.match(
      page,
      /Unchecked connection<i class="ii" tabindex="0" data-tip="Tick this only for a kubeconfig that skips TLS checks \(insecure-skip-tls-verify\) or reaches its API server over plain http:\/\/\./,
    );
    assert.match(
      page,
      /name="unchecked" value="1"[^>]*> I accept that this cluster's connection isn't checked\./,
    );
    const skips = `${KUBECONFIG}# insecure-skip-tls-verify: true\n`;
    assert.match(
      await add("k8s-a", skips),
      /error=Not added: cluster "c" skips TLS checks \(insecure-skip-tls-verify\), so control can't tell the real API server from another on the way\. Give it a kubeconfig with its certificate-authority-data over https, or tick "I accept that this cluster's connection isn't checked" to add it anyway\./,
    );
    assert.match(
      await add("k8s-a", `${KUBECONFIG}# server: http://k.example.com\n`),
      /error=Not added: cluster "c" reaches its API server over plain http/,
    );
    assert.equal(s.store.clusters.get("k8s-a"), undefined, "nothing is kept");
    assert.match(
      await add("k8s-a", skips, { unchecked: "1" }),
      /ok="k8s-a" is added and checked: see what control found below\. You accepted that its connection isn't checked: cluster "c" skips TLS checks \(insecure-skip-tls-verify\)\./,
    );
    const k = s.store.clusters.get("k8s-a");
    assert.deepEqual(k?.unchecked?.what, [
      'cluster "c" skips TLS checks (insecure-skip-tls-verify)',
    ]);
    assert.equal(k?.unchecked?.by, "owner:ui");
    assert.match(
      await s.page("/ui/settings"),
      /<span class="chip warn" title="cluster &quot;c&quot; skips TLS checks \(insecure-skip-tls-verify\)">connection not checked: you accepted it [^<]+ ago<\/span>/,
    );
    const added = s.store.auditLog.list(10, { action: "cluster_added" })[0]?.body as Record<
      string,
      unknown
    >;
    assert.deepEqual(added.unchecked_accepted, [
      'cluster "c" skips TLS checks (insecure-skip-tls-verify)',
    ]);
    // A checked kubeconfig needs no tick and shows no chip.
    await add("k8s-b", KUBECONFIG);
    assert.equal(s.store.clusters.get("k8s-b")?.unchecked, null);
  });
});
