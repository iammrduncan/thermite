import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { shellQuote } from "../../../src/common/exec.ts";
import { makeDeployKey } from "../../../src/control/git-keys.ts";
import {
  CHECK_SCRIPT,
  factsLine,
  missing,
  parseFacts,
} from "../../../src/control/machines/facts.ts";
import { NVIDIA_TOOLKIT_VERSION, recipeScript } from "../../../src/control/machines/recipes.ts";
import {
  ADDRESS,
  fingerprint,
  parseHostKeys,
  publicKeyOf,
  sshError,
  USER,
} from "../../../src/control/machines/ssh.ts";

describe("machines over SSH", () => {
  test("words are quoted for the shell; addresses and users that ssh could misread are refused", () => {
    assert.equal(shellQuote("it's"), `'it'\\''s'`);
    const out = execFileSync("sh", [
      "-c",
      `printf '%s|' ${shellQuote("a b")} ${shellQuote("$(id)")} ${shellQuote("it's")}`,
    ]);
    assert.equal(String(out), "a b|$(id)|it's|");
    for (const ok of ["gpu-box.example.com", "192.0.2.10", "fe80::1", "box1"])
      assert.ok(ADDRESS.test(ok), ok);
    for (const bad of ["-oProxyCommand=x", "a b", "box;id", ""]) assert.ok(!ADDRESS.test(bad), bad);
    assert.ok(USER.test("thermite") && !USER.test("-l") && !USER.test("root;id"));
  });

  test("host keys and key fingerprints read as ssh prints them", async () => {
    const k = makeDeployKey("thermite test");
    const dir = mkdtempSync(join(tmpdir(), "thermite-ssh-test-"));
    writeFileSync(join(dir, "key.pub"), `${k.publicKey}\n`);
    const printed = String(execFileSync("ssh-keygen", ["-lf", join(dir, "key.pub")])).split(" ")[1];
    assert.equal(fingerprint(k.publicKey.split(" ")[1] ?? ""), printed);
    // The public half control derives from a pasted private key is the same.
    const pub = await publicKeyOf(k.privateKey);
    assert.equal(pub.fingerprint, printed);
    await assert.rejects(publicKeyOf("not a key"), /not an SSH private key/);
    // ssh-keyscan's lines: the ed25519 key first, comments skipped.
    const [, b64] = k.publicKey.split(" ");
    const keys = parseHostKeys(
      `# box:22 SSH-2.0-OpenSSH_9.6\nbox ssh-rsa ${b64}\nbox ssh-ed25519 ${b64}\nbox ecdsa-sha2-nistp256 ${b64}\n`,
    );
    assert.deepEqual(
      keys.map((x) => x.type),
      ["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"],
    );
    assert.equal(keys[0]?.fingerprint, printed);
  });

  test("ssh's own failures say what happened", () => {
    assert.match(
      sshError(
        "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.",
      ),
      /different host key/,
    );
    assert.match(sshError("thermite@box: Permission denied (publickey)."), /refused the key/);
    assert.match(
      sshError("ssh: connect to host box port 22: Connection refused"),
      /nothing accepts SSH/,
    );
  });

  test("the check reads facts and changes nothing; its output parses into what a rig needs", () => {
    // The script runs as written under sh here (no GPU, possibly no /proc): it must not fail.
    const out = String(execFileSync("sh", ["-s", "--", "", ""], { input: CHECK_SCRIPT }));
    const here = parseFacts(out);
    assert.ok(here.kernel && here.user && here.cpus > 0, out);
    const f = parseFacts(
      [
        "os=Ubuntu 24.04.1 LTS",
        "os_id=ubuntu debian",
        "kernel=6.8.0-45-generic",
        "arch=x86_64",
        "cpus=32",
        "mem_kib=131072000",
        "disk_free_kib=1610612736",
        "user=thermite",
        "uid=1001",
        "gpu=0, GPU-aaaa, NVIDIA GeForce RTX 4090, 24564, 412, 0",
        "gpu=1, GPU-bbbb, NVIDIA GeForce RTX 4090, 24564, 1, 3",
        "driver=550.127.05",
        "cuda=12.4",
        "podman=4.9.3",
        "systemd=255",
        "linger=no",
        "sudo=yes",
        "reaches_control=200",
      ].join("\n"),
    );
    assert.equal(f.gpus.length, 2);
    assert.deepEqual(f.gpus[1], {
      index: 1,
      uuid: "GPU-bbbb",
      name: "NVIDIA GeForce RTX 4090",
      memory_mib: 24564,
      used_mib: 1,
      busy_pct: 3,
    });
    assert.equal(f.linger, false);
    assert.equal(f.sudo, true);
    assert.deepEqual(missing(f), ["nvidia_toolkit", "linger"]);
    assert.equal(
      factsLine(f),
      "2 × NVIDIA GeForce RTX 4090 · Ubuntu 24.04.1 LTS · 32 CPUs · 125 GB memory · Podman 4.9.3",
    );
    assert.deepEqual(missing({ ...f, podman: undefined, gpus: [], linger: true }), ["podman"]);
  });

  test("installs are fixed recipes: NVIDIA's documented commands, sudo that never waits, no recipe for an unknown system", () => {
    const base = parseFacts("os=Ubuntu 24.04 LTS\nos_id=ubuntu debian\nuser=thermite\nsudo=yes");
    const tk = recipeScript("nvidia_toolkit", base);
    assert.ok("script" in tk);
    if ("script" in tk) {
      assert.match(tk.script, /^set -eu\n/);
      assert.match(
        tk.script,
        /nvidia\.github\.io\/libnvidia-container\/stable\/deb\/nvidia-container-toolkit\.list/,
      );
      assert.ok(tk.script.includes(`nvidia-container-toolkit=${NVIDIA_TOOLKIT_VERSION}`));
      assert.match(tk.script, /nvidia-ctk cdi generate --output=\/var\/run\/cdi\/nvidia\.yaml/);
      // Every root command goes through sudo -n: it fails rather than wait for a password.
      for (const line of tk.script.split("\n").filter((l) => /\bsudo\b/.test(l)))
        assert.ok(!/\bsudo (?!-n)/.test(line), line);
    }
    const fedora = recipeScript("podman", { ...base, os_id: "fedora", os: "Fedora Linux 41" });
    assert.deepEqual(fedora, { script: "set -eu\nsudo -n dnf install -y podman" });
    assert.deepEqual(recipeScript("linger", base), {
      script: "set -eu\nsudo -n loginctl enable-linger 'thermite'",
    });
    assert.match(
      String(
        (recipeScript("podman", { ...base, os_id: "arch", os: "Arch Linux" }) as { error: string })
          .error,
      ),
      /no recipe for Arch Linux/,
    );
    assert.match(
      String((recipeScript("podman", { ...base, sudo: false }) as { error: string }).error),
      /can't sudo without a password/,
    );
  });
});
