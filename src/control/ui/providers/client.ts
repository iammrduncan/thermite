import { LOCAL_HTTP_HOSTS } from "../../../common/mcp-client.ts";
import { PRICE_NUMBER, PRICE_WORDS } from "../usage.ts";

/**
 * A row of Model prices without the page (goal 075): whether its three fields, as typed, set a
 * price, remove it (all empty) or can't be saved, and why, in the words the server uses
 * (PRICE_WORDS). The page's script runs it as it is, and so do its tests.
 */
export const PRICE_CORE_JS = `
const prNum = ${String(PRICE_NUMBER)};
const prWords = ${JSON.stringify(PRICE_WORDS)};
function prJudge(v) {
  const t = {};
  for (const k of ["in", "cached", "out"]) {
    const x = String(v[k] ?? "").trim();
    if (x !== "" && !prNum.test(x)) return ["bad", prWords.number];
    t[k] = x === "" ? null : Number(x);
  }
  if ((t.in === null) !== (t.out === null) || (t.cached !== null && t.in === null)) return ["bad", prWords.pair];
  return [t.in === null ? "none" : "set", ""];
}
`;

/**
 * The Providers page's script, served from control (/ui/assets/providers.js; no inline script
 * runs under the dashboard's CSP). The add form shows only the fields its type uses, and says
 * what adding it does. The MCP server form (goal 068) shows the fields of its kind of sign-in,
 * says what is wrong before it is sent, and for an OAuth server opens the server's sign-in page
 * in a new tab once control has kept the server. Without the script every field shows and the
 * forms still work: an OAuth server then gets a sign-in link on the page.
 */
/**
 * The MCP server form's check of a URL, as browser code: the rules of mcpUrlProblem
 * (common/mcp-client.ts), with its local hosts given to it, so the form refuses what control
 * refuses and no more. Null when the URL is fine, else why not, in words.
 */
export const MCP_URL_CHECK_JS = `(u) => {
  if (!/^https?:[/][/][^ /]+/.test(u)) return "The URL starts with https://.";
  let host = "";
  try { host = new URL(u).hostname; } catch {}
  if (u.startsWith("http://") && !${JSON.stringify(LOCAL_HTTP_HOSTS)}.includes(host)) return "Use https. Over http, the sign-in or key crosses the network in plain text, so control refuses it.";
  if (/[?&][^=]*(token|key|secret|password|auth|sig)[^=]*=/i.test(u)) return "Put no secret in the URL. Use Sign-in for it.";
  return null;
}`;

export const PROVIDERS_JS = `
(() => {
  "use strict";
  const form = document.getElementById("prov-add");
  if (form) {
    const says = JSON.parse(form.dataset.says || "{}");
    const type = form.elements.type;
    const show = () => {
      const t = type.value;
      for (const el of form.querySelectorAll("[data-for]")) el.hidden = !el.dataset.for.split(" ").includes(t);
      const s = says[t] || ["Add it", ""];
      document.getElementById("padd").textContent = s[0];
      const what = document.getElementById("pdo");
      what.replaceChildren();
      const b = document.createElement("b");
      b.textContent = "What happens.";
      what.append(b, " " + s[1]);
      form.elements.name.placeholder = t === "gitkey" || t === "gittoken" ? "for example github-deploy" : t === "runpod" ? "for example runpod" : t === "claude" ? "for example claude-max" : t === "chatgpt" ? "for example chatgpt-pro" : "for example my-litellm";
    };
    type.addEventListener("change", show);
    show();
  }

  // ------------------------------------------------ Model prices (goal 075)
  // Each row's fields are checked as they are typed: a field that is not a number is marked, and
  // the line by Save says which model's row can't be saved and why. Save waits for a change.
${PRICE_CORE_JS}
  const mpf = document.querySelector("form[data-mp-form]");
  const mpSave = mpf && mpf.querySelector("[data-mp-save]");
  if (mpf && mpSave) {
    const flash = mpf.querySelector("[data-mp-flash]");
    const check = () => {
      let bad = null;
      for (const tr of mpf.querySelectorAll("tr[data-mp]")) {
        const v = {};
        tr.querySelectorAll("[data-pk]").forEach((i) => {
          const x = i.value.trim();
          i.classList.toggle("bad", x !== "" && !prNum.test(x));
          v[i.dataset.pk] = x;
        });
        const [state, why] = prJudge(v);
        if (state === "bad" && !bad) bad = tr.dataset.mp + ": " + why;
      }
      const dirty = [...mpf.querySelectorAll("[data-pk]")].some((i) => i.value !== i.defaultValue);
      mpSave.disabled = !dirty || bad !== null;
      return bad;
    };
    mpf.addEventListener("input", (e) => {
      if (!e.target.matches("[data-pk]")) return;
      const bad = check();
      flash.replaceChildren();
      if (bad) {
        const b = document.createElement("b");
        b.className = "bad";
        b.textContent = "Not yet.";
        flash.append(b, " " + bad);
      }
    });
    check();
  }

  // ------------------------------------------------ Add an MCP server
  const mf = document.getElementById("mcp-add");
  if (!mf) return;
  const say = JSON.parse(mf.dataset.says || "{}");
  const el = (id) => document.getElementById(id);
  const auth = el("m-auth"), go = el("m-go"), does = el("m-does");
  const check = () => {
    for (const f of mf.querySelectorAll("[data-auth]")) f.hidden = f.dataset.auth !== auth.value;
    const s = say[auth.value] || ["Add and read its tools", ""];
    go.textContent = s[0];
    const n = el("m-name").value.trim(), u = el("m-url").value.trim();
    const problems = [];
    if (n && !/^[a-z0-9][a-z0-9-]*$/.test(n)) problems.push("A name is lowercase letters, digits and dashes.");
    if (n && [...document.querySelectorAll("[data-mcp]")].some((r) => r.dataset.mcp === n)) problems.push("There is a server named " + n + " already.");
    const urlProblem = u ? (${MCP_URL_CHECK_JS})(u) : null;
    if (urlProblem) problems.push(urlProblem);
    if (auth.value === "key" && !el("m-key").value.trim()) problems.push("Paste the key's value.");
    if (auth.value === "client" && !(el("m-cid").value.trim() && el("m-csec").value.trim())) problems.push("Fill in the client ID and its secret.");
    does.replaceChildren();
    const b = document.createElement("b");
    if (problems.length && (n || u)) {
      b.className = "bad";
      b.textContent = "Not yet.";
      does.append(b, " " + problems.join(" "));
    } else {
      b.textContent = "What happens.";
      does.append(b, " " + s[1]);
    }
    go.disabled = !(n && u) || problems.length > 0;
  };
  mf.addEventListener("input", check);
  mf.addEventListener("change", check);
  // OAuth: control keeps the server, then the new tab goes on to the server's own sign-in page
  // (a link, since a form may not go to another site); this page shows the new row.
  mf.addEventListener("submit", async (e) => {
    if (auth.value !== "oauth") return;
    e.preventDefault();
    const name = el("m-name").value.trim();
    const tab = window.open("about:blank", "_blank");
    try {
      const res = await fetch(mf.action, { method: "POST", body: new URLSearchParams(new FormData(mf)), credentials: "same-origin" });
      const back = new URL(res.url);
      if (tab && back.searchParams.get("signin") === name) tab.location.href = "/ui/settings/mcp/" + encodeURIComponent(name) + "/sign-in";
      else if (tab) tab.close();
      location.href = back.pathname + back.search + "#mcp";
    } catch {
      if (tab) tab.close();
      mf.submit();
    }
  });
  check();
})();
`;
