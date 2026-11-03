import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import {
  gaveSecret,
  givenSecrets,
  scrubSecrets,
  withoutCredentials,
} from "../../src/common/scrub.ts";

/**
 * The scrubber (goal 175): the values a process gave an agent blanked out exactly, in the shapes an
 * agent prints them in, then anything shaped like a key, a token or a password.
 */

const token = () => randomBytes(32).toString("hex");
/** A private key's kind, made here so that this file holds no key's header. */
const KEY_KIND = ["OPENSSH", "PRIVATE", "KEY"].join(" ");

describe("the values given to agents, blanked out exactly", () => {
  test("as given, inside JSON, split across lines, and in base64", () => {
    const v = token();
    const wrapped = (s: string, at: number, gap: string) => `${s.slice(0, at)}${gap}${s.slice(at)}`;
    const shapes = {
      plain: `the credential is trial.${v} for now`,
      json: JSON.stringify({ env: { THE_VAR: `trial.${v}` }, note: "a tool's answer" }),
      escaped: JSON.stringify(JSON.stringify({ given: v })),
      "a line break": wrapped(v, 40, "\n"),
      "a terminal's wrap and indent": wrapped(v, 33, "\r\n    "),
      "JSON's escaped line break": wrapped(v, 50, "\\n"),
      "a break in its first characters": wrapped(v, 3, "\n"),
      "breaks at both ends": wrapped(wrapped(v, 60, "\n"), 4, " "),
      base64: Buffer.from(v).toString("base64"),
      "base64 of a longer text": Buffer.from(`echo trial.${v}\n`).toString("base64"),
      "base64, URL-safe": Buffer.from(`x${v}`).toString("base64url"),
    };
    for (const [shape, text] of Object.entries(shapes)) {
      const out = scrubSecrets(text, [v]);
      assert.match(out, /\*\*\*/, shape);
      assert.ok(!out.replace(/\s|\\n/g, "").includes(v), `${shape}: ${out}`);
      // Nothing of its middle is left in base64 either.
      assert.ok(!out.includes(Buffer.from(v).toString("base64").slice(4, 40)), shape);
    }
    // The text around it stays.
    assert.equal(scrubSecrets(`a ${v} b`, [v]), "a *** b");
  });

  test("a process remembers the values it gave, the newest first, and scrubs every one", () => {
    const a = token();
    const b = token();
    gaveSecret(a);
    gaveSecret(b);
    gaveSecret("short");
    assert.deepEqual(givenSecrets().slice(0, 2), [b, a]);
    assert.ok(!givenSecrets().includes("short"), "a value too short to be a credential");
    assert.equal(scrubSecrets(`${a} and ${b}`), "*** and ***");
  });

  test("what it can't know stays: a hex dump of a value, or words alone", () => {
    const v = token();
    const hex = Buffer.from(v).toString("hex");
    assert.equal(scrubSecrets(hex, [v]), hex);
    assert.equal(scrubSecrets("plain words, nothing given", [v]), "plain words, nothing given");
  });
});

describe("the shapes of credentials", () => {
  const cases: [string, string, RegExp][] = [
    [
      "a URL's password",
      "https://deploy:pw@git.example.com/x",
      /^https:\/\/\*\*\*@git\.example\.com\/x$/,
    ],
    ["a bearer token", "Bearer abc.def-123", /^Bearer \*\*\*$/],
    ["a basic credential", "Basic ZGVwbG95OnB3MTIz", /^Basic \*\*\*$/],
    [
      "a known key prefix",
      `key ${["sk", "ant", "oat01", "AbCdEfGhIj"].join("-")}`,
      /^key sk-\*\*\*$/,
    ],
    ["a GitHub token", "ghp_AbCdEfGh0123456789", /^ghp_\*\*\*$/],
    ["an AWS key id", `AKIA${"ABCDEFGHIJKLMNOP"}`, /^AKIA\*\*\*$/],
    ["a credential Thermite makes", `call.${"ab".repeat(24)}`, /^call\.\*\*\*$/],
    ["a NATS seed", `SU${"A".repeat(56)}`, /^S\*\*\*$/],
    ["a JSON web token", "eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeK", /^\*\*\*$/],
    [
      "a private key",
      `-----BEGIN ${KEY_KIND}-----\nb3BlbnNzaA==\n-----END ${KEY_KIND}-----`,
      new RegExp(`^-----BEGIN ${KEY_KIND}-----\\*\\*\\*-----END ${KEY_KIND}-----$`),
    ],
    ["a variable", "OPENCODE_SERVER_PASSWORD=Zm9vYmFy", /^OPENCODE_SERVER_PASSWORD=\*\*\*$/],
    ["an AUTH variable", "THERMITE_TRIAL_AUTH=anything-here", /^THERMITE_TRIAL_AUTH=\*\*\*$/],
    ["a variable in JSON", '{"MY_API_KEY": "abc123"}', /^\{"MY_API_KEY": "\*\*\*"\}$/],
    ["a field in JSON", '{"password": "hunter2"}', /^\{"password": "\*\*\*"\}$/],
    ["a query string", "https://x.example/cb?access_token=abc&n=1", /access_token=\*\*\*&n=1$/],
    ["a header", "x-api-key: abc123", /^x-api-key: \*\*\*$/],
    ["a cookie", "cookie: session=abc123", /^cookie: \*\*\*$/],
  ];
  for (const [what, text, want] of cases)
    test(what, () => assert.match(withoutCredentials(text), want));

  test("a commit, a file's SHA-256 and plain words stay", () => {
    const text = `commit ${"a1".repeat(20)}, sha256 ${"c3".repeat(32)}: the keys of the map are sorted.`;
    assert.equal(withoutCredentials(text), text);
  });
});
