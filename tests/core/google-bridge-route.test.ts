import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { googleBridgeBase, rebaseGoogleRoute } from "../../src/core/google-gemini.ts";

// Control writes its public address into a Gemini API route; this rig can't reach it.
const ADVERTISED = "https://control.example.com/v1/google-gemini/gem";
const google = {
  name: "gem",
  type: "google-gemini-api",
  base_url: ADVERTISED,
  api_key: "capability",
};

describe("a Gemini API route reaches control's bridge where its caller reaches control", () => {
  test("an unreachable advertised address is replaced by the rig's own control address, same bridge and capability", () => {
    const moved = rebaseGoogleRoute(google, "http://control:8800");
    assert.equal(moved.base_url, "http://control:8800/v1/google-gemini/gem");
    assert.equal(moved.api_key, "capability");
    assert.equal(moved.name, "gem");
    // The given route is not changed in place.
    assert.equal(google.base_url, ADVERTISED);
  });

  test("a path prefix is kept, trailing slashes dropped, and IPv6 hosts and ports kept", () => {
    assert.equal(
      googleBridgeBase("https://h.example/thermite/", "gem"),
      "https://h.example/thermite/v1/google-gemini/gem",
    );
    assert.equal(
      googleBridgeBase("https://h.example/thermite//", "gem"),
      "https://h.example/thermite/v1/google-gemini/gem",
    );
    assert.equal(
      googleBridgeBase("http://[fd00::5]:8800", "gem"),
      "http://[fd00::5]:8800/v1/google-gemini/gem",
    );
    assert.equal(
      googleBridgeBase("http://127.0.0.1:8790/", "a.b_c-d"),
      "http://127.0.0.1:8790/v1/google-gemini/a.b_c-d",
    );
    // A route control wrote behind a sub-path is still its provider's bridge.
    const sub = { ...google, base_url: "https://h.example/thermite/v1/google-gemini/gem/" };
    assert.equal(
      rebaseGoogleRoute(sub, "http://control:8800").base_url,
      "http://control:8800/v1/google-gemini/gem",
    );
  });

  test("every other provider's route comes back as it was, the same object, whatever the address", () => {
    for (const type of ["openai", "anthropic", "chatgpt", "claude", "opencode", undefined]) {
      const route = { name: "other", type, base_url: "https://api.example.com/v1", api_key: "k" };
      const before = JSON.stringify(route);
      assert.equal(rebaseGoogleRoute(route, "http://control:8800"), route, String(type));
      assert.equal(JSON.stringify(route), before);
    }
    // A route with no type or address at all (an older control's), too.
    const bare = { name: "r", version: 2, revision: "bbbbbbbb" };
    assert.equal(rebaseGoogleRoute(bare, "http://control:8800"), bare);
  });

  test("with no address of the rig's own, a Gemini API route is left as control gave it", () => {
    assert.equal(rebaseGoogleRoute(google, undefined), google);
  });

  test("a control address that is not plain http(s) is refused", () => {
    for (const bad of [
      "ftp://control:8800",
      "file:///etc/passwd",
      "http://user:pass@control:8800",
      "http://token@control:8800",
      "http://control:8800/?next=x",
      "http://control:8800/#frag",
      "http://control:8800?",
      " http://control:8800",
      "http://control:8800/a b",
      "http://control:8800\\@evil.example",
      "control:8800",
      "not an address",
    ])
      assert.throws(() => rebaseGoogleRoute(google, bad), /Control's address/u, bad);
  });

  test("a Gemini API route that names another provider's bridge or another path is refused", () => {
    const drifted = [
      { ...google, base_url: "https://control.example.com/v1/google-gemini/someone-else" },
      { ...google, base_url: "https://control.example.com/v1/google-gemini/xgem" },
      { ...google, base_url: "https://control.example.com/v1/other/gem" },
      { ...google, base_url: "https://control.example.com/" },
      { ...google, base_url: "https://u:p@control.example.com/v1/google-gemini/gem" },
      { ...google, base_url: "https://control.example.com/v1/google-gemini/gem?x=1" },
      { ...google, base_url: "ftp://control.example.com/v1/google-gemini/gem" },
      {
        ...google,
        name: "Not A Name",
        base_url: "https://control.example.com/v1/google-gemini/Not A Name",
      },
      { ...google, name: undefined },
      { ...google, base_url: undefined },
    ];
    for (const route of drifted)
      assert.throws(
        () => rebaseGoogleRoute(route, "http://control:8800"),
        Error,
        JSON.stringify(route),
      );
  });
});
