const $ = (id) => document.getElementById(id);
const DASHBOARD = "https://one.dash.cloudflare.com/?to=/:account/access/ai-controls/mcp-server-portal";

// Build DOM without innerHTML: tool names and descriptions come from upstream servers.
function h(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children.filter((c) => c != null));
  return el;
}

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

const showError = (error) => { $("banner").textContent = error.message; $("banner").hidden = false; };

// What a newly deployed app exports, with the addresses someone has to copy.
function showDeployed(made) {
  const lines = [
    made.tools?.length && `Tools: ${made.tools.join(", ")}`,
    ...Object.entries(made.schedules ?? {}).map(([name, cron]) => `Schedule ${name}: ${cron} (UTC)`),
    ...(made.webhooks ?? []).map((url) => `Webhook: ${url}`),
    ...(made.pages ?? []).map((url) => `Page: ${url}`),
    made.workflows?.length && `Workflows: ${made.workflows.join(", ")}`,
  ].filter(Boolean);
  $("notice").textContent = `Deployed ${made.id}.\n${lines.join("\n")}`;
  $("notice").hidden = !lines.length;
}

// Run a write, then reload. Disables the control meanwhile so it can't be sent twice.
async function act(control, fn) {
  control.disabled = true;
  $("banner").hidden = true;
  try { await fn(); await load(); } catch (error) { showError(error); await load().catch(() => {}); }
  control.disabled = false;
}

// ---- Secret fields: write-only, masked, wiped whenever their dialog closes ----

function secretFields(container) {
  const rows = h("div", { className: "stack" });
  const add = h("button", { type: "button", textContent: "Add a secret" });
  const addRow = (name = "") => {
    const remove = h("button", { type: "button", textContent: "Remove", ariaLabel: "Remove this secret" });
    const row = h("div", { className: "secret" },
      h("input", { type: "text", placeholder: "NAME", ariaLabel: "Secret name", pattern: "[A-Z][A-Z0-9_]*", required: true, autocomplete: "off", spellcheck: false }),
      h("input", { type: "password", placeholder: "value", ariaLabel: "Secret value", required: true, autocomplete: "new-password" }),
      remove);
    remove.onclick = () => row.remove();
    rows.append(row);
    row.children[0].value = name;
    row.children[name ? 1 : 0].focus();
  };
  add.onclick = () => addRow();
  container.append(rows, h("div", {}, add));
  return {
    values: () => Object.fromEntries([...rows.children].map((r) => [r.children[0].value, r.children[1].value])),
    clear: () => rows.replaceChildren(),
    add: addRow,
  };
}

// Wire a dialog so that closing it by any route leaves no secret in the page.
// Returns the function that closes it. The wipe runs before close() rather than
// only on the "close" event, which browsers delay (and skip in hidden tabs).
function secretDialog(dialog, form, error, secrets) {
  const wipe = () => { form.reset(); secrets.clear(); error.hidden = true; };
  const close = () => { wipe(); dialog.close(); };
  dialog.addEventListener("close", wipe); // Esc key
  dialog.querySelector("[data-close]").onclick = close;
  return close;
}

async function submit(e, error, close, send) {
  e.preventDefault();
  e.submitter.disabled = true;
  try {
    const result = await send();
    close();
    await load();
    return result;
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    e.submitter.disabled = false;
  }
}

// ---- Integrations ----

const STATUS = { ready: "Ready", waiting: "Waiting for sign-in", stale: "Needs sync", error: "Error" };

function integrationRow(i, open) {
  const status = (i.status || "waiting").toLowerCase().replace(/ .*/, "");
  const on = i.tools.filter((t) => t.enabled).length;
  const tools = i.tools.length
    ? i.tools.map((t) => {
        const box = h("input", { type: "checkbox", checked: t.enabled, id: `t-${i.id}-${t.name}` });
        box.onchange = () => act(box, () => api("PUT", `/api/integrations/${i.id}/tools`, { tool: t.name, enabled: box.checked }));
        return h("div", { className: "tool" }, box, h("label", { htmlFor: box.id }, h("code", {}, t.name)), h("small", {}, t.description || ""));
      })
    : [h("small", {}, i.auth_type === "oauth"
        ? (i.auth_mode === "manual"
            ? "Tools appear after the first person signs in to this integration from their agent."
            : "No tools yet. Open Admin sign-in, go to the MCP servers tab, select the three dots beside this server and choose Re-authenticate server. Then sync here.")
        : "No tools found yet. Try a sync.")];

  const sync = h("button", { textContent: "Sync tools" });
  sync.onclick = () => act(sync, () => api("POST", `/api/integrations/${i.id}/sync`));
  const edit = i.is_app ? h("button", { textContent: "Update script or secrets" }) : null;
  if (edit) edit.onclick = () => openApp(i);
  const review = i.pending_review ? h("button", { className: "primary", textContent: "Review proposed change" }) : null;
  if (review) review.onclick = () => openReview(i).catch(showError);
  const remove = h("button", { className: "danger", textContent: "Remove" });
  remove.onclick = () => {
    if (remove.dataset.armed) return act(remove, () => api("DELETE", `/api/integrations/${i.id}`));
    remove.dataset.armed = "1";
    remove.textContent = "Really remove?";
    setTimeout(() => { delete remove.dataset.armed; remove.textContent = "Remove"; }, 4000);
  };

  return h("details", { className: "row", open, id: `i-${i.id}` },
    h("summary", {},
      h("span", { className: "grow wrap" }, h("strong", {}, i.name), h("br"), h("small", {}, i.is_app ? "Runs on runkle" : i.url)),
      h("small", {}, i.tools.length ? `${on} of ${i.tools.length} tools on` : ""),
      h("span", { className: `badge ${status}` }, STATUS[status] || i.status)),
    i.error ? h("p", { className: "error tools" }, i.error) : null,
    i.secrets_set?.length ? h("p", { className: "muted tools" }, `Secrets set: ${i.secrets_set.join(", ")}`) : null,
    h("div", { className: "tools" }, ...tools),
    h("div", { className: "actions" }, review, sync, edit,
      i.auth_type === "oauth" && i.auth_mode !== "manual" ? h("a", { className: "button", href: DASHBOARD, target: "_blank", rel: "noopener", textContent: "Admin sign-in ↗" }) : null,
      remove));
}

async function load() {
  const s = await api("GET", "/api/state");
  const open = new Set([...document.querySelectorAll("#integrations details[open]")].map((d) => d.id));
  $("me").textContent = `${s.portal.name} · ${s.me}`;
  $("integrations").replaceChildren(...(s.integrations.length
    ? s.integrations.map((i) => integrationRow(i, open.has(`i-${i.id}`)))
    : [h("p", { className: "row muted" }, "Nothing connected yet. Add a remote MCP server or upload a script, and its tools show up here.")]));
  $("endpoint").value = s.endpoint;
  $("admin-endpoint").value = `${location.origin}/mcp`;
  $("snippet").textContent = `# Claude Code\nclaude mcp add --transport http runkle ${s.endpoint}\n\n# Anything else: add a remote (streamable HTTP) MCP server with this URL`;
  $("code-mode").value = s.portal.code_mode || "opt_in";
  const form = $("agent-auth"), a = s.agentAuth;
  $("auth-missing").hidden = Boolean(a);
  for (const el of form.elements) el.disabled = !a;
  if (a && !form.contains(document.activeElement)) {
    form.enabled.checked = a.enabled;
    form.allow_localhost.checked = a.allow_localhost;
    form.allow_loopback.checked = a.allow_loopback;
    form.allowed_uris.value = a.allowed_uris.join("\n");
  }
  return s;
}

for (const button of document.querySelectorAll("[data-copy]"))
  button.onclick = async () => {
    await navigator.clipboard.writeText($(button.dataset.copy).value);
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy"), 1500);
  };
$("code-mode").onchange = (e) => act(e.target, () => api("PUT", "/api/portal", { code_mode: e.target.value }));

$("agent-auth").onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  act(e.submitter, () => api("PUT", "/api/agent-auth", {
    enabled: f.enabled.checked,
    allow_localhost: f.allow_localhost.checked,
    allow_loopback: f.allow_loopback.checked,
    allowed_uris: f.allowed_uris.value.split("\n").map((u) => u.trim()).filter(Boolean),
  }));
};

// ---- Add integration ----

const form = $("new");
const newSecrets = secretFields(form.querySelector("[data-secrets]"));
function showFields() {
  form.querySelectorAll("[data-kind]").forEach((el) => (el.hidden = el.dataset.kind !== form.kind.value));
  form.querySelectorAll("[data-for]").forEach((el) => (el.hidden = el.dataset.for !== form.auth.value));
  form.url.required = form.kind.value === "server";
  form.file.required = form.kind.value === "app";
  form.skill_files.required = form.kind.value === "skills";
  if (form.kind.value !== "app") newSecrets.clear(); // hidden required fields would block the form
}
form.kind.onchange = form.auth.onchange = showFields;
const closeNew = secretDialog($("dialog"), form, $("form-error"), newSecrets);
$("add").onclick = () => { $("notice").hidden = true; showFields(); $("dialog").showModal(); };
form.onsubmit = async (e) => {
  const made = await submit(e, $("form-error"), closeNew, async () => {
    const name = form.elements.name.value;
    if (form.kind.value === "app") return api("POST", "/api/apps", { name, source: await form.file.files[0].text(), secrets: newSecrets.values() });
    if (form.kind.value === "skills")
      return api("POST", "/api/skills", { name, skills: await Promise.all([...form.skill_files.files].map((f) => f.text())) });
    if (form.kind.value === "api")
      return api("POST", "/api/sources", {
        name,
        kind: form.format.value,
        url: form.api_url.value,
        spec: await form.spec.files[0]?.text(),
        base_url: form.base_url.value,
        filter: form.filter.value,
        auth: form.api_auth.value,
        auth_name: form.auth_name.value,
        token: form.api_token.value,
      });
    const { name: _, url, auth, token, client_id, client_secret, authorization_endpoint, token_endpoint, scope } = Object.fromEntries(new FormData(form));
    return api("POST", "/api/integrations", { name, url, auth, token, client_id, client_secret, authorization_endpoint, token_endpoint, scope });
  });
  if (made) showDeployed(made);
  const row = made && $(`i-${made.id}`);
  if (row) row.open = true;
};

// ---- Update an uploaded script ----

const appForm = $("app-form");
const appSecrets = secretFields(appForm.querySelector("[data-secrets]"));
function openApp(i) {
  appForm.dataset.id = i.id;
  $("h-app").textContent = `Update ${i.name}`;
  $("app-dialog").showModal();
}
const closeApp = secretDialog($("app-dialog"), appForm, $("app-error"), appSecrets);
appForm.onsubmit = (e) =>
  submit(e, $("app-error"), closeApp, async () => {
    const file = appForm.file.files[0];
    return api("PUT", `/api/apps/${appForm.dataset.id}`, { ...(file && { source: await file.text() }), secrets: appSecrets.values() });
  }).then((made) => made?.id && showDeployed(made));

// ---- Review a change an agent proposed to a script that holds secrets ----

// Line diff by longest common subsequence.
// ponytail: O(lines squared) memory, fine for scripts of a few thousand lines; swap in Myers if one ever stalls.
function diffLines(a, b) {
  const n = a.length, m = b.length, w = m + 1, lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  const out = [];
  for (let i = 0, j = 0; i < n || j < m; ) {
    if (i < n && j < m && a[i] === b[j]) out.push([" ", a[i++]]), j++;
    else if (j < m && (i === n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) out.push(["+", b[j++]]);
    else out.push(["-", a[i++]]);
  }
  return out;
}

const reviewForm = $("review-form");
async function openReview(i) {
  const p = await api("GET", `/api/apps/${i.id}/proposal`);
  reviewForm.dataset.id = i.id;
  reviewForm.dataset.version = p.version;
  $("h-review").textContent = `Review change to ${i.name}`;
  $("review-error").hidden = true;
  // Only changed lines and three lines around each, like a patch.
  const lines = diffLines(p.current.split("\n"), p.proposed.split("\n"));
  const near = lines.map((_, k) => lines.slice(Math.max(0, k - 3), k + 4).some(([mark]) => mark !== " "));
  $("review-diff").replaceChildren(...lines.flatMap(([mark, text], k) =>
    near[k] ? [h("span", { className: mark === "+" ? "add" : mark === "-" ? "del" : "", textContent: `${mark} ${text}` })]
    : near[k - 1] || k === 0 ? [h("span", { className: "muted", textContent: "  ⋯" })] : []));
  if (!near.includes(true)) $("review-diff").textContent = "The proposed source is identical to the deployed one.";
  $("review-dialog").showModal();
}
reviewForm.onsubmit = async (e) => {
  if (e.submitter.value === "close") return; // method="dialog" closes it
  e.preventDefault();
  for (const b of reviewForm.querySelectorAll("button")) b.disabled = true;
  try {
    const made = await api("POST", `/api/apps/${reviewForm.dataset.id}/proposal`, { version: reviewForm.dataset.version, approve: e.submitter.value === "approve" });
    $("review-dialog").close();
    if (e.submitter.value === "approve" && made.id) showDeployed(made);
  } catch (error) {
    $("review-error").textContent = error.message;
    $("review-error").hidden = false;
  }
  for (const b of reviewForm.querySelectorAll("button")) b.disabled = false;
  await load().catch(() => {});
};

// A link an agent handed over (see credentialLink and serverLink in src/ops.ts)
// opens the matching form. It can name fields but never carries a secret, and
// everything it sets is checked here: the address bar is not a trusted source.
function openFromLink(s) {
  const link = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname);
  const target = s.integrations.find((i) => i.is_app && i.id === link.get("secrets"));
  if (target) {
    openApp(target);
    for (const name of (link.get("names") || "").split(",")) if (/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) appSecrets.add(name);
  } else if (link.has("review")) {
    const waiting = s.integrations.find((i) => i.pending_review && i.id === link.get("review"));
    if (waiting) openReview(waiting).catch(showError);
    else showError(new Error("Nothing is waiting for review. It may already have been decided."));
  } else if (link.has("add")) {
    $("add").click();
    form.elements.name.value = link.get("name") || "";
    form.url.value = link.get("url") || "";
    if (["bearer", "oauth_manual"].includes(link.get("auth"))) form.auth.value = link.get("auth");
    showFields();
  }
}

load().then(openFromLink, (error) => {
  showError(error);
  $("integrations").replaceChildren(h("p", { className: "row muted" }, "Couldn't load integrations."));
});
